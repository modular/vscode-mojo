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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { extension } from '../extension';

const modularHome = path.join(process.env.HOME!, '.modular');
const modularConfig = path.join(modularHome, 'modular.cfg');
const modularPackageRoot = path.join(
  modularHome,
  'pkg',
  'packages.modular.com_mojo',
);
const modularLsp = path.join(modularPackageRoot, 'bin', 'mojo-lsp-server');

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function createDerivedConfig(): string {
  return [
    '[max]',
    'version = 0.0.0-test',
    '',
    '[mojo-max]',
    `lsp_server_path = ${path.join(modularPackageRoot, 'bin', 'mojo-lsp-server')}`,
    `mblack_path = ${path.join(modularPackageRoot, 'lib', 'mblack', 'mblack')}`,
    `lldb_plugin_path = ${path.join(modularPackageRoot, 'lib', 'libMojoLLDB.dylib')}`,
    `lldb_vscode_path = ${path.join(modularPackageRoot, 'bin', 'lldb-dap')}`,
    `driver_path = ${path.join(modularPackageRoot, 'bin', 'mojo')}`,
    `lldb_visualizers_path = ${path.join(modularPackageRoot, 'lib', 'lldb-visualizers')}`,
    `lldb_path = ${path.join(modularPackageRoot, 'bin', 'lldb')}`,
    '',
  ].join('\n');
}

async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

suite('Completion', function () {
  test('trigger-character completion should work immediately after typing "."', async function () {
    if (!(await pathExists(modularConfig)) || !(await pathExists(modularLsp))) {
      this.skip();
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspaceFolder, 'expected a workspace folder');

    const workspaceRoot = workspaceFolder.uri.fsPath;
    const derivedPath = path.join(workspaceRoot, '.derived');
    let derivedExisted = false;
    try {
      const derivedStat = await fs.lstat(derivedPath);
      derivedExisted = true;
      if (!derivedStat.isDirectory()) {
        await fs.rm(derivedPath, { recursive: true, force: true });
        derivedExisted = false;
      }
    } catch {
      derivedExisted = false;
    }

    const createdDerivedDir = !derivedExisted;
    if (createdDerivedDir) {
      await fs.mkdir(derivedPath, { recursive: true });
    }
    await fs.writeFile(
      path.join(derivedPath, path.basename(modularConfig)),
      createDerivedConfig(),
    );

    const testFile = vscode.Uri.file(
      path.join(workspaceRoot, 'completion-trigger-race.test.mojo'),
    );

    try {
      await vscode.workspace.fs.writeFile(
        testFile,
        Buffer.from('import math\n\nfn main():\n    math'),
      );

      await vscode.commands.executeCommand('mojo.extension.restart');

      const document = await vscode.workspace.openTextDocument(testFile);
      const editor = await vscode.window.showTextDocument(document);
      assert.strictEqual(document.languageId, 'mojo');
      await withTimeout(
        extension.lspManager!.tryStartLanguageClient(document),
        30000,
        'language client startup',
      );
      assert.strictEqual(
        extension.lspManager!.lspClient?.name,
        'Mojo Language Client',
      );

      const line = document.lineAt(document.lineCount - 1);
      const cursor = line.range.end;
      editor.selection = new vscode.Selection(cursor, cursor);

      await vscode.commands.executeCommand('default:type', { text: '.' });

      const completion = await withTimeout(
        vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          editor.selection.active,
          '.',
        ),
        30000,
        'trigger-character completion request',
      );

      assert.ok(completion, 'expected a completion result');
      assert.ok(
        completion.items.length > 0,
        'expected trigger-character completion items after typing "."',
      );
    } finally {
      await vscode.commands.executeCommand(
        'workbench.action.closeActiveEditor',
      );
      await vscode.workspace.fs.delete(testFile, { useTrash: false });
      if (createdDerivedDir) {
        await fs.rm(derivedPath, { recursive: true, force: true });
      }
    }
  });
});
