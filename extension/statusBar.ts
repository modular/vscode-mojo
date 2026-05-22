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

import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import { SDK, SDKKind } from './pyenv';

const SDK_KIND_LABELS: Record<SDKKind, string> = {
  [SDKKind.Environment]: 'env',
  [SDKKind.Custom]: 'custom',
  [SDKKind.Internal]: 'dev',
};

function editorHasMojoFile(): boolean {
  return vscode.window.visibleTextEditors.some(
    (editor) => editor.document.languageId === 'mojo',
  );
}

export type SDKMissingReason = 'no-python-extension' | 'invalid-sdk-override';

export class SDKStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private lspStatusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private visible = false;
  private workspaceHasMojo: boolean | undefined = undefined;
  private readonly showOutputCommand: string;
  private onShouldRefresh: vscode.EventEmitter<void> =
    new vscode.EventEmitter();
  readonly onRefreshRequested: vscode.Event<void> = this.onShouldRefresh.event;

  constructor(showOutputCommand: string) {
    this.showOutputCommand = showOutputCommand;
    this.statusBarItem = vscode.window.createStatusBarItem(
      'mojo-sdk-status',
      vscode.StatusBarAlignment.Left,
      66,
    );
    this.statusBarItem.name = 'Mojo SDK';
    this.statusBarItem.command = showOutputCommand;

    this.lspStatusBarItem = vscode.window.createStatusBarItem(
      'mojo-lsp-status',
      vscode.StatusBarAlignment.Left,
      65,
    );
    this.lspStatusBarItem.name = 'Mojo LSP';
    this.lspStatusBarItem.command = 'mojo.lsp.restart';
    this.updateLsp(undefined);

    // Watch for mojo files being opened.
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.checkVisibility()),
    );

    // Watch for mojo files being created/deleted in the workspace.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.mojo');
    this.disposables.push(watcher);
    this.disposables.push(
      watcher.onDidCreate(() => {
        this.workspaceHasMojo = true;
        this.checkVisibility();
      }),
    );
    this.disposables.push(
      watcher.onDidDelete(() => {
        this.workspaceHasMojo = undefined; // invalidate cache
        this.checkVisibility();
      }),
    );
  }

  async checkVisibility() {
    if (editorHasMojoFile()) {
      this.show();
      return;
    }

    if (this.workspaceHasMojo === undefined) {
      const results = await vscode.workspace.findFiles('**/*.mojo', null, 1);
      this.workspaceHasMojo = results.length > 0;
    }

    if (this.workspaceHasMojo) {
      this.show();
    } else if (this.visible) {
      this.visible = false;
      this.statusBarItem.hide();
      this.lspStatusBarItem.hide();
    }
  }

  private show() {
    if (!this.visible) {
      this.visible = true;
      this.statusBarItem.show();
      this.lspStatusBarItem.show();
      this.onShouldRefresh.fire();
    }
  }

  showLoading() {
    this.statusBarItem.text = '$(loading~spin) Mojo';
    this.statusBarItem.tooltip = 'Detecting Mojo SDK...';
    this.statusBarItem.backgroundColor = undefined;
  }

  update(
    sdk: SDK | undefined,
    reason?: SDKMissingReason,
    pickerDivergencePath?: string,
  ) {
    if (sdk) {
      const version = sdk.version.replace(/^mojo\s*/i, '').trim();
      const kindLabel = SDK_KIND_LABELS[sdk.kind];
      this.statusBarItem.text = `$(check) Mojo ${version} (${kindLabel})`;
      let tooltip = `**Mojo SDK** (${kindLabel})\n\nVersion: ${version}\n\nPath: ${sdk.mojoPath}`;
      if (pickerDivergencePath) {
        tooltip +=
          `\n\n*Note:* differs from the environment selected via ` +
          `\`Python: Select Interpreter\` (\`${pickerDivergencePath}\`). ` +
          'Set `mojo.preferPixiEnv` to `false` if you prefer the picker as ' +
          'the authoritative source.';
      }
      this.statusBarItem.tooltip = new vscode.MarkdownString(tooltip);
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
      this.statusBarItem.command = this.showOutputCommand;
    } else if (reason === 'no-python-extension') {
      this.statusBarItem.text = '$(warning) Mojo: Install Python extension';
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        'The Python extension (`ms-python.python`) is required to discover ' +
          'Mojo SDKs in pixi or wheel environments.\n\nClick to open it in the marketplace.',
      );
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.color = undefined;
      this.statusBarItem.command = {
        command: 'extension.open',
        arguments: ['ms-python.python'],
        title: 'Open Python extension in marketplace',
      };
    } else if (reason === 'invalid-sdk-override') {
      this.statusBarItem.text = '$(error) Mojo: Invalid SDK override path';
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        'The `mojo.sdk.path` setting is set but does not point to a valid ' +
          'Mojo SDK. The extension will not fall back to other detection ' +
          'while this override is set.\n\nClick to retry detection (useful ' +
          'if you have just finished creating the environment), or edit the ' +
          '`mojo.sdk.path` setting to change the path.',
      );
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.errorBackground',
      );
      this.statusBarItem.color = undefined;
      this.statusBarItem.command = 'mojo.sdk.refresh';
    } else {
      this.statusBarItem.text = '$(warning) Mojo: No SDK';
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        "Couldn't find a Mojo SDK. The extension looked for, in order:\n\n" +
          '1. The `mojo.sdk.path` override setting\n' +
          '2. The monorepo `.derived/` SDK\n' +
          '3. A workspace pixi env containing `share/max/modular.cfg` ' +
          '(`pixi add mojo`)\n' +
          '4. The active Python interpreter\n\n' +
          'Click to view logs.',
      );
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
      this.statusBarItem.color = new vscode.ThemeColor(
        'statusBarItem.warningForeground',
      );
      this.statusBarItem.command = this.showOutputCommand;
    }
  }

  updateLsp(state: vscodelc.State | undefined) {
    const errorBg = new vscode.ThemeColor('statusBarItem.errorBackground');

    switch (state) {
      case vscodelc.State.Running:
        this.lspStatusBarItem.text = '$(check) Mojo LSP';
        this.lspStatusBarItem.tooltip =
          'Mojo language server is running. Click to restart.';
        this.lspStatusBarItem.backgroundColor = undefined;
        break;
      case vscodelc.State.Starting:
        this.lspStatusBarItem.text = '$(loading~spin) Mojo LSP';
        this.lspStatusBarItem.tooltip = 'Mojo language server is starting...';
        this.lspStatusBarItem.backgroundColor = undefined;
        break;
      case vscodelc.State.Stopped:
        this.lspStatusBarItem.text = '$(error) Mojo LSP stopped';
        this.lspStatusBarItem.tooltip =
          'Mojo language server is not running. Click to restart.';
        this.lspStatusBarItem.backgroundColor = errorBg;
        break;
      default:
        this.lspStatusBarItem.text = '$(circle-slash) Mojo LSP';
        this.lspStatusBarItem.tooltip = 'Mojo language server has not started.';
        this.lspStatusBarItem.backgroundColor = undefined;
        break;
    }
  }

  dispose() {
    this.statusBarItem.dispose();
    this.lspStatusBarItem.dispose();
    this.onShouldRefresh.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
