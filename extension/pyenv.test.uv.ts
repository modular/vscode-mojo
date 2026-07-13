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

import * as assert from 'assert';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { extension } from './extension';
import { SDKKind } from './pyenv';

const execAsync = promisify(exec);

suite('pyenv', function () {
  test('should detect uv/venv environments', async function () {
    await vscode.commands.executeCommand('mojo.extension.restart');
    const sdk = await extension.pyenvManager!.getActiveSDK();
    assert.ok(sdk);
    assert.strictEqual(sdk.kind, SDKKind.Environment);

    // Wheel installs don't ship a modular.cfg — sdk.version comes from
    // invoking `mojo --version`. Reproduce the same call to assert the
    // extension reads what's actually installed, without hardcoding
    // the version string.
    const workspaceFolder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const mojoPath = path.join(workspaceFolder, '.venv/bin/mojo');
    const { stdout } = await execAsync(`"${mojoPath}" --version`);
    assert.strictEqual(sdk.version, stdout);
  });
});
