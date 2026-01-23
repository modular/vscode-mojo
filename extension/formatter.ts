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

import { execFile } from 'child_process';
import * as vscode from 'vscode';

import { get } from './utils/config';
import { PythonEnvironmentManager } from './pyenv';
import { Logger } from './logging';

export function registerFormatter(
  envManager: PythonEnvironmentManager,
  logger: Logger,
) {
  return vscode.languages.registerDocumentFormattingEditProvider('mojo', {
    async provideDocumentFormattingEdits(document, _options) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      const backupFolder = vscode.workspace.workspaceFolders?.[0];
      const cwd = workspaceFolder?.uri?.fsPath || backupFolder?.uri.fsPath;
      const args = get<string[]>('formatting.args', workspaceFolder, []);

      const sdk = await envManager.getActiveSDK();

      if (!sdk) {
        return [];
      }

      return new Promise<vscode.TextEdit[]>(function (resolve, reject) {
        const originalDocumentText = document.getText();
        const process = execFile(
          sdk.mblackPath,
          ['--fast', '--preview', '--quiet', '-t', 'mojo', ...args, '-'],
          { cwd, env: sdk.getProcessEnv() },
          (error, stdout, stderr) => {
            // Process any errors/warnings during formatting. These aren't all
            // necessarily fatal, so this doesn't prevent edits from being
            // applied.
            if (error) {
              logger.error(`Formatting error:\n${stderr}`);
              reject(error);
              return;
            }

            // Formatter returned nothing, don't try to apply any edits.
            if (originalDocumentText.length > 0 && stdout.length === 0) {
              resolve([]);
              return;
            }

            // Otherwise, the formatter returned the formatted text. Update the
            // document.
            const documentRange = new vscode.Range(
              document.lineAt(0).range.start,
              document.lineAt(document.lineCount - 1).rangeIncludingLineBreak
                .end,
            );
            resolve([new vscode.TextEdit(documentRange, stdout)]);
          },
        );

        process.stdin?.write(originalDocumentText);
        process.stdin?.end();
      });
    },
  });
}
