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

import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';
import { TransportKind } from 'vscode-languageclient/node';

import * as config from '../utils/config';
import { DisposableContext } from '../utils/disposableContext';
import { Subject } from 'rxjs';
import { Logger } from '../logging';
import { TelemetryReporter } from '../telemetry';
import { LSPRecorder } from './recorder';
import { Optional } from '../types';
import { PythonEnvironmentManager, SDK } from '../pyenv';
import path from 'path';

/**
 * This type represents the initialization options send by the extension to the
 * proxy.
 */
export interface InitializationOptions {
  /**
   * The path to `mojo-lsp-server`.
   */
  serverPath: string;
  /**
   * The arguments to use when invoking `mojo-lsp-server`.
   */
  serverArgs: string[];
  /**
   * The environment to use when invoking `mojo-lsp-server`.
   */
  serverEnv: { [env: string]: Optional<string> };
}

/**
 *  This class manages the LSP clients.
 */
export class MojoLSPManager extends DisposableContext {
  private extensionContext: vscode.ExtensionContext;
  private envManager: PythonEnvironmentManager;
  public lspClient: Optional<vscodelc.LanguageClient>;
  public lspClientChanges = new Subject<Optional<vscodelc.LanguageClient>>();
  private logger: Logger;
  private reporter: TelemetryReporter;
  private recorder: Optional<LSPRecorder>;
  private statusBarItem: Optional<vscode.StatusBarItem>;
  private attachDebugger: boolean = false;

  constructor(
    envManager: PythonEnvironmentManager,
    extensionContext: vscode.ExtensionContext,
    logger: Logger,
    reporter: TelemetryReporter,
  ) {
    super();

    this.envManager = envManager;
    this.extensionContext = extensionContext;
    this.logger = logger;
    this.reporter = reporter;
  }

  async activate() {
    this.pushSubscription(
      vscode.commands.registerCommand('mojo.lsp.restart', async () => {
        // Wait for the language server to stop. This allows a graceful shutdown of the server instead of simply terminating the process, which is important for tracing.
        if (this.lspClient) {
          await this.lspClient.stop();
        }

        this.dispose();
        this.lspClient = undefined;
        await this.activate();
      }),
    );

    this.pushSubscription(
      vscode.commands.registerCommand('mojo.lsp.stop', async () => {
        if (this.lspClient) {
          await this.lspClient.stop();
          // We do not set lspClient to undefined, as this would trigger
          // restarting the client when a new mojo file is opened.
        }
      }),
    );

    if (
      this.extensionContext.extensionMode == vscode.ExtensionMode.Development ||
      this.extensionContext.extensionMode == vscode.ExtensionMode.Test
    ) {
      this.pushSubscription(
        vscode.commands.registerCommand('mojo.lsp.debug', async () => {
          if (this.lspClient) {
            await this.lspClient.stop();
          }

          this.attachDebugger = true;

          this.dispose();
          this.lspClient = undefined;
          await this.activate();
        }),
      );

      this.pushSubscription(
        vscode.commands.registerTextEditorCommand(
          'mojo.lsp.dumpParsedIR',
          async (textEditor) => {
            if (!this.lspClient) {
              return;
            }

            await this.lspClient.sendNotification('mojo/emitParsedIR', {
              uri: textEditor.document.uri.toString(),
            });
          },
        ),
      );
    }

    this.statusBarItem = vscode.window.createStatusBarItem(
      'lsp-recording-state',
      vscode.StatusBarAlignment.Right,
    );
    this.statusBarItem.text = 'Mojo LSP $(record)';
    this.statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground',
    );
    this.statusBarItem.command = 'mojo.lsp.stopRecord';
    this.pushSubscription(this.statusBarItem);

    this.pushSubscription(
      vscode.commands.registerCommand('mojo.lsp.startRecord', async () => {
        if (this.recorder) {
          this.recorder.dispose();
        }

        if (
          !vscode.workspace.workspaceFolders ||
          vscode.workspace.workspaceFolders.length == 0
        ) {
          return;
        }
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const recordPath = vscode.Uri.joinPath(
          workspaceFolder.uri,
          'mojo-lsp-recording.jsonl',
        );

        this.recorder = new LSPRecorder(recordPath.fsPath);
        this.pushSubscription(this.recorder);

        vscode.window
          .showInformationMessage(
            `Started recording language server session to ${recordPath}.`,
            'Stop',
            'Open',
          )
          .then((action) => {
            switch (action) {
              case 'Open':
                return vscode.commands.executeCommand(
                  'vscode.open',
                  recordPath,
                );
              case 'Stop':
                return vscode.commands.executeCommand('mojo.lsp.stopRecord');
            }
          });

        this.statusBarItem!.tooltip = `Recording Mojo LSP session to ${recordPath}`;
        this.statusBarItem!.show();
      }),
    );

    this.pushSubscription(
      vscode.commands.registerCommand('mojo.lsp.stopRecord', async () => {
        if (!this.recorder) {
          return;
        }

        this.recorder!.dispose();
        this.recorder = undefined;
        this.statusBarItem!.hide();
      }),
    );

    vscode.workspace.textDocuments.forEach((doc) =>
      this.tryStartLanguageClient(doc),
    );
    this.pushSubscription(
      vscode.workspace.onDidOpenTextDocument((doc) =>
        this.tryStartLanguageClient(doc),
      ),
    );

    this.pushSubscription(
      this.envManager.onEnvironmentChange(() => {
        this.logger.info('Restarting language server due to SDK change');
        vscode.commands.executeCommand('mojo.lsp.restart');
      }),
    );
  }

  async tryStartLanguageClient(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== 'mojo') {
      return;
    }

    const sdk = await this.envManager.getActiveSDK();

    if (!sdk) {
      return;
    }

    if (this.lspClient !== undefined) {
      return;
    }

    const includeDirs = config.get<string[]>(
      'lsp.includeDirs',
      /*workspaceFolder=*/ undefined,
      [],
    );
    const lspClient = this.activateLanguageClient(sdk, includeDirs);
    this.lspClient = lspClient;
    this.lspClientChanges.next(lspClient);
    this.pushSubscription(
      new vscode.Disposable(() => {
        lspClient.stop();
        lspClient.dispose();
        this.lspClientChanges.next(undefined);
        this.lspClientChanges.unsubscribe();
      }),
    );
  }

  /**
   * Create a new language server.
   */
  activateLanguageClient(
    sdk: SDK,
    includeDirs: string[],
  ): vscodelc.LanguageClient {
    this.logger.lsp.info('Activating language client');

    const serverArgs: string[] = [];

    for (const includeDir of includeDirs) {
      serverArgs.push('-I', includeDir);
    }

    if (this.attachDebugger) {
      serverArgs.push('--attach-debugger-on-startup');
    }

    const initializationOptions: InitializationOptions = {
      serverArgs: serverArgs,
      serverEnv: sdk.getProcessEnv(),
      serverPath: sdk.lspPath,
    };

    const module = this.extensionContext.asAbsolutePath(
      this.extensionContext.extensionMode == vscode.ExtensionMode.Development
        ? path.join('lsp-proxy', 'out', 'proxy.js')
        : path.join('out', 'proxy.js'),
    );

    const serverOptions: vscodelc.ServerOptions = {
      run: { module, transport: TransportKind.ipc },
      debug: { module, transport: TransportKind.ipc },
    };

    // Configure the client options.
    const clientOptions: vscodelc.LanguageClientOptions = {
      // The current selection mechanism indicates all documents to be served
      // by the same single LSP Server. This wouldn't work if at some point
      // we support multiple SDKs running at once, for which we'd need a more
      // flexible way to manage LSP Servers than `vscodelc`. Two options might
      // be feasible:
      // - Fork/contribute `vscodelc` and allow for a more customizable selection logic.
      // - Do the selection within the proxy, which would be "easy" to implement
      //   if the proxy is restarted with the new correct info whenever a new SDK is
      //   identified.
      documentSelector: [
        {
          language: 'mojo',
        },
        {
          scheme: 'vscode-notebook-cell',
          language: 'mojo',
        },
      ],
      synchronize: {
        // Notify the server about file changes following the given file
        // pattern.
        fileEvents: vscode.workspace.createFileSystemWatcher(
          '**/*.{mojo,🔥,ipynb}',
        ),
      },
      outputChannel: this.logger.lsp.outputChannel,

      // Don't switch to output window when the server returns output.
      revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,
      initializationOptions: initializationOptions,
    };

    clientOptions.middleware = {
      sendRequest: (method, param, token, next) => {
        if (this.recorder) {
          return this.recorder.sendRequest(method, param, token, next);
        } else {
          return next(method, param, token);
        }
      },
      sendNotification: (method, next, param) => {
        if (this.recorder) {
          return this.recorder.sendNotification(method, next, param);
        } else {
          return next(method, param);
        }
      },
      async handleDiagnostics(uri, diagnostics, next) {
        if (
          config.get<boolean>(
            'lsp.suppress.diagnostics.in.docstring',
            /*workspaceFolder=*/ undefined,
            false,
          )
        ) {
          const document = await vscode.workspace.openTextDocument(uri);
          const foldingRanges = await vscode.commands.executeCommand<
            vscode.FoldingRange[]
          >('vscode.executeFoldingRangeProvider', uri);
          const docstringRanges = foldingRanges.filter((r) => {
            return document.lineAt(r.start).text.trimStart().startsWith('"""');
          });
          diagnostics = diagnostics.filter((d) => {
            for (let index = 0; index < docstringRanges.length; index++) {
              const range = docstringRanges[index];
              if (
                d.range.start.line > range.start &&
                d.range.end.line < range.end
              ) {
                return false;
              }
            }
            return true;
          });
        }
        next(uri, diagnostics);
      },
    };

    // Create the language client and start the client.
    const languageClient = new vscodelc.LanguageClient(
      'mojo-lsp',
      'Mojo Language Client',
      serverOptions,
      clientOptions,
    );

    // The proxy sends us a mojo/lspRestart notification when it restarts the
    // underlying language server. It's our job to pass that to the telemetry
    // backend.
    this.pushSubscription(
      languageClient.onNotification('mojo/lspRestart', () => {
        this.reporter.sendTelemetryEvent('lspRestart', {
          mojoSDKVersion: sdk.version,
          mojoSDKKind: sdk.kind,
        });
      }),
    );

    this.logger.lsp.info(
      `Launching Language Server '${
        initializationOptions.serverPath
      }' with options:`,
      initializationOptions.serverArgs,
    );
    this.logger.lsp.info('Launching Language Server');
    // We intentionally don't await the `start` so that we can cancelling it
    // during a long initialization, which can happen when in debug mode.
    languageClient.start();
    return languageClient;
  }
}
