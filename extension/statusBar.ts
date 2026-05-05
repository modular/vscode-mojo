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

export class SDKStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private visible = false;
  private workspaceHasMojo: boolean | undefined = undefined;
  private onShouldRefresh: vscode.EventEmitter<void> =
    new vscode.EventEmitter();
  readonly onRefreshRequested: vscode.Event<void> = this.onShouldRefresh.event;

  constructor(showOutputCommand: string) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      'mojo-sdk-status',
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.statusBarItem.name = 'Mojo SDK';
    this.statusBarItem.command = showOutputCommand;

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
    }
  }

  private show() {
    if (!this.visible) {
      this.visible = true;
      this.statusBarItem.show();
      this.onShouldRefresh.fire();
    }
  }

  showLoading() {
    this.statusBarItem.text = '$(loading~spin) Mojo';
    this.statusBarItem.tooltip = 'Detecting Mojo SDK...';
    this.statusBarItem.backgroundColor = undefined;
  }

  update(sdk: SDK | undefined) {
    if (sdk) {
      const version = sdk.version.replace(/^mojo\s*/i, '').trim();
      const kindLabel = SDK_KIND_LABELS[sdk.kind];
      this.statusBarItem.text = `$(check) Mojo ${version} (${kindLabel})`;
      this.statusBarItem.tooltip = new vscode.MarkdownString(
        `**Mojo SDK** (${kindLabel})\n\nVersion: ${version}\n\nPath: ${sdk.mojoPath}`,
      );
      this.statusBarItem.backgroundColor = undefined;
    } else {
      this.statusBarItem.text = '$(warning) Mojo: No SDK';
      this.statusBarItem.tooltip = 'No Mojo SDK detected. Click to view logs.';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    }
  }

  dispose() {
    this.statusBarItem.dispose();
    this.onShouldRefresh.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
