//===----------------------------------------------------------------------===//
// Copyright (c) 2025, Modular Inc. All rights reserved.
//
// Licensed under the Apache License v2.0 with LLVM Exceptions:
// https://llvm.org/LICENSE.txt
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//===----------------------------------------------------------------------===//

import * as vscode from 'vscode';

const SEMANTIC_TOKEN_ENTRY_SIZE = 5;

export type SemanticTokenTypeIndexes = {
  variable: number;
  type: number;
};

type SemanticTokenSpan = {
  line: number;
  character: number;
  length: number;
  tokenType: number;
  tokenModifiers: number;
};

function decodeSemanticTokens(data: Uint32Array): SemanticTokenSpan[] {
  const tokens: SemanticTokenSpan[] = [];
  let line = 0;
  let character = 0;

  for (let i = 0; i < data.length; i += SEMANTIC_TOKEN_ENTRY_SIZE) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    tokens.push({
      line,
      character,
      length: data[i + 2],
      tokenType: data[i + 3],
      tokenModifiers: data[i + 4],
    });
  }

  return tokens;
}

function encodeSemanticTokens(tokens: SemanticTokenSpan[]): Uint32Array {
  const data = new Uint32Array(tokens.length * SEMANTIC_TOKEN_ENTRY_SIZE);
  let previousLine = 0;
  let previousCharacter = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const offset = i * SEMANTIC_TOKEN_ENTRY_SIZE;
    const deltaLine = token.line - previousLine;
    data[offset] = deltaLine;
    data[offset + 1] =
      deltaLine === 0 ? token.character - previousCharacter : token.character;
    data[offset + 2] = token.length;
    data[offset + 3] = token.tokenType;
    data[offset + 4] = token.tokenModifiers;
    previousLine = token.line;
    previousCharacter = token.character;
  }

  return data;
}

function findTypeContextStart(line: string, character: number): number {
  const prefix = line.slice(0, character);
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: string | undefined;
  let contextStart = -1;

  for (let i = 0; i < prefix.length; i++) {
    const current = prefix[i];
    const previous = prefix[i - 1];

    if (inString !== undefined) {
      if (current === inString && previous !== '\\') {
        inString = undefined;
      }
      continue;
    }

    if (current === '"' || current === "'") {
      inString = current;
      continue;
    }

    if (current === '[') {
      bracketDepth++;
    } else if (current === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    } else if (current === '(') {
      parenDepth++;
    } else if (current === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      if (bracketDepth === 0) {
        contextStart = -1;
      }
    }

    if (bracketDepth !== 0) {
      continue;
    }

    if (current === ':' && bracketDepth === 0) {
      contextStart = startsTypeAnnotation(prefix.slice(0, i), parenDepth)
        ? i + 1
        : -1;
      continue;
    }

    if (current === '-' && prefix[i + 1] === '>') {
      contextStart = i + 2;
      i++;
      continue;
    }

    if (current === ',' || current === '=' || current === '#') {
      contextStart = -1;
    }
  }

  return contextStart;
}

function startsTypeAnnotation(left: string, parenDepth: number): boolean {
  if (/\b(?:var|let)\s+[A-Za-z_]\w*\s*$/.test(left)) {
    return true;
  }

  return (
    parenDepth > 0 &&
    /(?:^|[,\(])\s*(?:(?:var|read|mut|out|ref)\s+)?[A-Za-z_]\w*\s*$/.test(left)
  );
}

function isInStructInheritance(line: string, character: number): boolean {
  const prefix = line.slice(0, character);
  return /\b(?:struct|trait|class)\s+\w+\s*\([^)]*$/.test(prefix);
}

function isTokenInTypeContext(
  document: vscode.TextDocument,
  token: SemanticTokenSpan,
): boolean {
  const line = document.lineAt(token.line).text;

  if (isInStructInheritance(line, token.character)) {
    return true;
  }

  const contextStart = findTypeContextStart(line, token.character);
  if (contextStart < 0) {
    return false;
  }

  const between = line.slice(contextStart, token.character);
  return !/[=#]/.test(between);
}

export function correctAliasSemanticTokens(
  document: vscode.TextDocument,
  semanticTokens: vscode.SemanticTokens | undefined,
  tokenTypeIndexes: SemanticTokenTypeIndexes | undefined,
): vscode.SemanticTokens | undefined {
  if (semanticTokens === undefined || tokenTypeIndexes === undefined) {
    return semanticTokens;
  }

  const tokens = decodeSemanticTokens(semanticTokens.data);
  let changed = false;

  for (const token of tokens) {
    if (
      token.tokenType === tokenTypeIndexes.variable &&
      isTokenInTypeContext(document, token)
    ) {
      token.tokenType = tokenTypeIndexes.type;
      changed = true;
    }
  }

  if (!changed) {
    return semanticTokens;
  }

  return new vscode.SemanticTokens(
    encodeSemanticTokens(tokens),
    semanticTokens.resultId,
  );
}
