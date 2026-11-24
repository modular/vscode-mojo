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
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as vscode from 'vscode';
import { extension } from './extension';
import { SDKKind } from './pyenv';

const execAsync = promisify(exec);

suite('pyenv', function () {
  test('should detect Pixi environments', async function () {
    await vscode.commands.executeCommand('mojo.extension.restart');
    const sdk = await extension.pyenvManager!.getActiveSDK();
    assert.ok(sdk);
    assert.strictEqual(sdk.kind, SDKKind.Environment);

    // sdk.version comes from invoking `mojo --version`. Reproduce the same
    // call to assert detection reports exactly what the installed mojo prints.
    const mojoPath = path.join(
      vscode.workspace.workspaceFolders![0].uri.fsPath,
      '.pixi/envs/default/bin/mojo',
    );
    const { stdout } = await execAsync(`"${mojoPath}" --version`);
    assert.strictEqual(sdk.version, stdout);
  });
});
