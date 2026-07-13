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
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as ini from 'ini';
import { extension } from './extension';
import { SDKKind } from './pyenv';

suite('pyenv', function () {
  test('should detect Pixi environments', async function () {
    await vscode.commands.executeCommand('mojo.extension.restart');
    const sdk = await extension.pyenvManager!.getActiveSDK();
    assert.ok(sdk);
    assert.strictEqual(sdk.kind, SDKKind.Environment);

    // Rather than hardcode a version string that would need updating on
    // every pixi.lock refresh, read the version from the same
    // modular.cfg file the extension parses. Asserts our detection
    // reads what pixi installed.
    const workspaceFolder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const cfgPath = path.join(
      workspaceFolder,
      '.pixi/envs/default/share/max/modular.cfg',
    );
    const cfg = ini.parse(await fs.promises.readFile(cfgPath, 'utf8'));
    assert.strictEqual(sdk.version, cfg.max.version);
  });
});
