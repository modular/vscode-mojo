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

import { Logger, LogLevel } from './logging';
import { MojoLSPManager } from './lsp/lsp';
import * as configWatcher from './utils/configWatcher';
import { DisposableContext } from './utils/disposableContext';
import { registerFormatter } from './formatter';
import { activateRunCommands } from './commands/run';
import { MojoDebugManager } from './debug/debug';
import { MojoDecoratorManager } from './decorations';
import { RpcServer } from './server/RpcServer';
import { Mutex } from 'async-mutex';
import { TelemetryReporter } from './telemetry';
import { PythonEnvironmentManager } from './pyenv';
import { setupWorkspaceWithPixi } from './utils/pixiSetup';

/**
 * This class provides an entry point for the Mojo extension, managing the
 * extension's state and disposal.
 */
export class MojoExtension extends DisposableContext {
  public logger: Logger;
  public readonly extensionContext: vscode.ExtensionContext;
  public lspManager?: MojoLSPManager;
  public pyenvManager?: PythonEnvironmentManager;
  private activateMutex = new Mutex();
  private reporter: TelemetryReporter;

  constructor(context: vscode.ExtensionContext, logger: Logger) {
    super();
    this.extensionContext = context;
    this.logger = logger;
    // NOTE: The telemetry connection string comes from the Azure Application Insights dashboard.
    this.reporter = new TelemetryReporter(
      context.extension.packageJSON.telemetryConnectionString,
    );
    this.pushSubscription(this.reporter);

    // Disable telemetry for development and test environments.
    this.reporter.enabled =
      context.extensionMode == vscode.ExtensionMode.Production;
  }

  async activate(reloading: boolean): Promise<MojoExtension> {
    return await this.activateMutex.runExclusive(async () => {
      if (reloading) {
        this.dispose();
      }

      this.logger.info(`
=============================
Activating the Mojo Extension
=============================
`);

      this.pyenvManager = new PythonEnvironmentManager(
        this.logger,
        this.reporter,
      );
      this.pushSubscription(this.pyenvManager);
      await this.pyenvManager.init();

      this.pushSubscription(
        await configWatcher.activate({
          settings: ['SDK.additionalSDKs'],
        }),
      );

      this.pushSubscription(
        vscode.commands.registerCommand('mojo.extension.restart', async () => {
          // Dispose and reactivate the context.
          await this.activate(/*reloading=*/ true);
        }),
      );

      this.pushSubscription(
        vscode.commands.registerCommand(
          'mojo.init.pixi.project.nightly',
          async () => {
            await setupWorkspaceWithPixi(logger, this.pyenvManager);
          },
        ),
      );

      // Initialize the formatter.
      this.pushSubscription(registerFormatter(this.pyenvManager, this.logger));

      // Initialize the debugger support.
      this.pushSubscription(new MojoDebugManager(this, this.pyenvManager));

      // Initialize the execution commands.
      this.pushSubscription(
        activateRunCommands(this.pyenvManager, this.extensionContext),
      );

      // Initialize the decorations.
      this.pushSubscription(new MojoDecoratorManager());

      // Initialize the LSPs
      this.lspManager = new MojoLSPManager(
        this.pyenvManager,
        this.extensionContext,
        this.logger,
        this.reporter,
      );
      await this.lspManager.activate();
      this.pushSubscription(this.lspManager);

      this.logger.info('MojoContext activated.');
      this.pushSubscription(
        new vscode.Disposable(() => {
          logger.info('Disposing MOJOContext.');
        }),
      );

      // Initialize the RPC server
      const rpcServer = new RpcServer(this.logger);
      this.logger.info('Starting RPC server');
      this.pushSubscription(rpcServer);
      rpcServer.listen();
      this.logger.info('Mojo extension initialized.');
      return this;
    });
  }

  override dispose() {
    this.logger.info('Disposing the extension.');
    super.dispose();
  }
}

export let extension: MojoExtension;
let logger: Logger;
let logHook: (level: string, message: string) => void;

/**
 *  This method is called when the extension is activated. See the
 * `activationEvents` in the package.json file for the current events that
 * activate this extension.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<MojoExtension> {
  logger = new Logger(
    context.extensionMode === vscode.ExtensionMode.Production
      ? LogLevel.Info
      : LogLevel.Debug,
  );

  if (logHook) {
    logger.main.logCallback = logHook;
    logger.lsp.logCallback = logHook;
  }

  extension = new MojoExtension(context, logger);
  return extension.activate(/*reloading=*/ false);
}

/**
 * This method is called with VS Code deactivates this extension because of
 * an upgrade, a window reload, the editor is shutting down, or the user
 * disabled the extension manually.
 */
export function deactivate() {
  logger.info('Deactivating the extension.');
  extension.dispose();
  logger.info('Extension deactivated.');
  logger.dispose();
}

export function setLogHook(hook: (level: string, message: string) => void) {
  logHook = hook;
  if (logger) {
    logger.main.logCallback = hook;
    logger.lsp.logCallback = hook;
  }
}
