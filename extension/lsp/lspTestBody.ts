//===----------------------------------------------------------------------===//
// Copyright (c) 2026, Modular Inc. All rights reserved.
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

// Shared LSP test body imported by lsp.test.pixi.ts and lsp.test.uv.ts.
// The tests are fixture-agnostic — they use workspaceFolders[0] so each
// label runs them against its own workspace.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { firstValueFrom } from 'rxjs';
import { extension } from '../extension';

suite('LSP', function () {
  test('LSP should not be loaded on startup', async function () {
    // Restart the extension. Tests run in a shared environment, so if other tests
    // have created the LSP, this test will fail otherwise.
    await vscode.commands.executeCommand('mojo.extension.restart');

    assert.strictEqual(extension.lspManager!.lspClient, undefined);
  });

  test('LSP should be launched when a Mojo file is opened', async function () {
    // Restart the extension. Tests run in a shared environment, so if other tests
    // have created the LSP, this test will fail otherwise.
    await vscode.commands.executeCommand('mojo.extension.restart');

    const lsp = firstValueFrom(extension.lspManager!.lspClientChanges);

    const workspaceFolder = vscode.workspace.workspaceFolders![0];
    await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, 'main.mojo')),
    );

    assert.strictEqual((await lsp)!.name, 'Mojo Language Client');
  });
});
