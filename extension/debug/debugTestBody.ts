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

// Shared debug test body imported by debug.test.pixi.ts and
// debug.test.uv.ts. The tests are fixture-agnostic — they use
// workspaceFolders[0] so each label runs them against its own workspace.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

suite('debug', function () {
  test('debug session runs and terminates cleanly for a mojo file', async function () {
    // Debug sessions are inherently async and vary by machine. Give the
    // whole thing plenty of headroom: build + LLDB launch + program run
    // + termination + cleanup should still fit comfortably inside 60s
    // on a slow CI runner.
    this.timeout(60_000);

    const workspaceFolder = vscode.workspace.workspaceFolders![0];
    const mojoFile = path.join(workspaceFolder.uri.fsPath, 'main.mojo');

    const startPromise = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((session) => {
        sub.dispose();
        resolve(session);
      });
    });
    const termPromise = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((session) => {
        sub.dispose();
        resolve(session);
      });
    });

    const started = await vscode.debug.startDebugging(workspaceFolder, {
      type: 'mojo-lldb',
      name: 'Debug main.mojo',
      request: 'launch',
      mojoFile,
    });
    assert.ok(started, 'startDebugging should have returned true');

    const session = await startPromise;
    assert.strictEqual(session.type, 'mojo-lldb');

    // The fixture's main.mojo is just `print(...)`, so it exits on its
    // own shortly after launch. We wait for the natural termination
    // rather than issuing a stop.
    const terminatedSession = await termPromise;

    // The extension records the temp binary path on the session config
    // and removes the enclosing directory in its own
    // onDidTerminateDebugSession handler. Both handlers fire on the
    // same event; JS event ordering doesn't guarantee ours runs after
    // the extension's, so poll briefly for the cleanup to happen.
    const tempBinary = terminatedSession.configuration['_mojoTempBinary'] as
      string | undefined;
    assert.ok(
      tempBinary,
      'Session config should carry _mojoTempBinary set by the resolver',
    );
    const tempDir = path.dirname(tempBinary);
    const deadline = Date.now() + 2_000;
    let cleaned = false;
    while (Date.now() < deadline) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(tempDir));
      } catch {
        cleaned = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(cleaned, `Temp dir ${tempDir} should have been cleaned up`);
  });

  test('debug session stops at a breakpoint and continues', async function () {
    this.timeout(60_000);

    const workspaceFolder = vscode.workspace.workspaceFolders![0];
    const mojoFile = path.join(workspaceFolder.uri.fsPath, 'main.mojo');

    // Set the breakpoint on line 2 (0-indexed as 1) — the print statement.
    // Line 1 is `def main():` which LLDB won't stop on.
    const breakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(mojoFile), new vscode.Position(1, 0)),
    );
    vscode.debug.addBreakpoints([breakpoint]);

    // Observe DAP traffic to catch the "stopped at breakpoint" event and
    // send a continue in response, so the program can exit and the test
    // can finish. Registered before startDebugging so the factory fires
    // for the session we're about to launch.
    let stoppedAtBreakpoint = false;
    const trackerReg = vscode.debug.registerDebugAdapterTrackerFactory(
      'mojo-lldb',
      {
        createDebugAdapterTracker(session) {
          return {
            onDidSendMessage(message) {
              if (
                message.type === 'event' &&
                message.event === 'stopped' &&
                message.body?.reason === 'breakpoint'
              ) {
                stoppedAtBreakpoint = true;
                void session.customRequest('continue', {
                  threadId: message.body.threadId,
                });
              }
            },
          };
        },
      },
    );

    try {
      const termPromise = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession(() => {
          sub.dispose();
          resolve();
        });
      });

      const started = await vscode.debug.startDebugging(workspaceFolder, {
        type: 'mojo-lldb',
        name: 'Debug main.mojo with breakpoint',
        request: 'launch',
        mojoFile,
      });
      assert.ok(started, 'startDebugging should have returned true');

      await termPromise;

      assert.ok(
        stoppedAtBreakpoint,
        'Session should have stopped at the breakpoint on line 2',
      );
    } finally {
      trackerReg.dispose();
      vscode.debug.removeBreakpoints([breakpoint]);
    }
  });
});
