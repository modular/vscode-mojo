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

import * as assert from 'assert';
import * as vscode from 'vscode';
import { correctAliasSemanticTokens } from './semanticTokens';

const variableTokenType = 0;
const typeTokenType = 8;

function createDocument(lines: string[]) {
  return {
    lineAt(line: number) {
      return { text: lines[line] } as vscode.TextLine;
    },
  } as unknown as vscode.TextDocument;
}

type TestToken = {
  line: number;
  character: number;
  length: number;
  tokenType?: number;
};

function encodeTokens(tokens: TestToken[]) {
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;

  for (const current of tokens) {
    const deltaLine = current.line - previousLine;
    data.push(
      deltaLine,
      deltaLine === 0
        ? current.character - previousCharacter
        : current.character,
      current.length,
      current.tokenType ?? variableTokenType,
      0,
    );
    previousLine = current.line;
    previousCharacter = current.character;
  }

  return new Uint32Array(data);
}

suite('Semantic token correction', () => {
  test('reclassifies aliases only in type positions', () => {
    const lines = [
      'var custom: MyInt',
      'def write_to(self, mut writer: Some[Writer]):',
      'def f() -> Int: return value',
      'return MyList[Int]()',
    ];
    const semanticTokens = new vscode.SemanticTokens(
      encodeTokens([
        {
          line: 0,
          character: lines[0].indexOf('MyInt'),
          length: 'MyInt'.length,
        },
        {
          line: 1,
          character: lines[1].indexOf('writer'),
          length: 'writer'.length,
        },
        { line: 1, character: lines[1].indexOf('Some'), length: 'Some'.length },
        {
          line: 1,
          character: lines[1].indexOf('Writer'),
          length: 'Writer'.length,
        },
        { line: 2, character: lines[2].indexOf('Int'), length: 'Int'.length },
        {
          line: 2,
          character: lines[2].indexOf('value'),
          length: 'value'.length,
        },
        {
          line: 3,
          character: lines[3].indexOf('MyList'),
          length: 'MyList'.length,
        },
      ]),
    );

    const corrected = correctAliasSemanticTokens(
      createDocument(lines),
      semanticTokens,
      { variable: variableTokenType, type: typeTokenType },
    );

    assert.ok(corrected);
    const tokenTypes = Array.from(corrected.data).filter((_, index) => {
      return index % 5 === 3;
    });
    assert.deepStrictEqual(tokenTypes, [
      typeTokenType,
      variableTokenType,
      typeTokenType,
      typeTokenType,
      typeTokenType,
      variableTokenType,
      variableTokenType,
    ]);
  });
});
