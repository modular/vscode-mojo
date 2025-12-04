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

import { checkNsightInstall } from '../utils/checkNsight';
import { DisposableContext } from '../utils/disposableContext';
import { getAllOpenMojoFiles, WorkspaceAwareFile } from '../utils/files';
import { activatePickProcessToAttachCommand } from './attachQuickPick';
import { initializeInlineLocalVariablesProvider } from './inlineVariables';
import { MojoExtension } from '../extension';
import { quote } from 'shell-quote';
import { Optional } from '../types';
import { PythonEnvironmentManager, SDK, SDKKind } from '../pyenv';
import { Logger } from '../logging';

/**
 * Stricter version of vscode.DebugConfiguration intended to reduce the chances
 * of typos when handling individual attributes.
 */
export type MojoDebugConfiguration = {
  type?: string;
  name?: string;
  pid?: string | number;
  request?: string;
  modularHomePath?: string;
  modularConfigMojoSection?: string;
  args?: string[];
  program?: string;
  mojoFile?: string;
  env?: string[];
  enableAutoVariableSummaries?: boolean;
  commandEscapePrefix?: string;
  timeout?: number;
  initCommands?: string[];
  customFrameFormat?: string;
  runInTerminal?: boolean;
  buildArgs?: string[];
  enableSyntheticChildDebugging?: boolean;
};

/**
 * Stricter version of vscode.DebugConfiguration intended to reduce the chances
 * of typos when handling individual attributes.
 */
type MojoCudaGdbDebugConfiguration = {
  type?: string;
  description?: string;
  name?: string;
  pid?: string | number;
  modularHomePath?: string;
  args?: string[];
  program?: string;
  mojoFile?: string;
  env?: string[];
  cwd?: string[];
  initCommands?: string[];
  stopOnEntry?: boolean;
  breakOnLaunch?: boolean;
};

/**
 * The "type" for debug configurations.
 */
const DEBUG_TYPE: string = 'mojo-lldb';

function envDictToList(dict: { [key: string]: string }): string[] {
  return Object.entries(dict).map(([k, v]) => `${k}=${v}`);
}

/**
 * Some debug configurations come from an RPC call, which have an explicit SDK
 * to use. We should honor it when running the debug session.
 */
async function findSDKForDebugConfiguration(
  config: MojoDebugConfiguration,
  envManager: PythonEnvironmentManager,
): Promise<Optional<SDK>> {
  if (config.modularHomePath !== undefined) {
    const homePath = config.modularHomePath.replace(/\/+$/, '');
    const prefixPath = homePath.endsWith('/share/max')
      ? homePath.replace(/\/share\/max$/, '')
      : undefined;
    return envManager.createSDKFromHomePath(
      SDKKind.Custom,
      homePath,
      prefixPath,
    );
  }
  return envManager.getActiveSDK();
}
/**
 * This class defines a factory used to find the lldb-vscode binary to use
 * depending on the session configuration.
 */
class MojoDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  private envManager: PythonEnvironmentManager;
  private logger: Logger;

  constructor(envManager: PythonEnvironmentManager, logger: Logger) {
    this.envManager = envManager;
    this.logger = logger;
  }

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    _executable: Optional<vscode.DebugAdapterExecutable>,
  ): Promise<Optional<vscode.DebugAdapterDescriptor>> {
    const sdk = await findSDKForDebugConfiguration(
      session.configuration,
      this.envManager,
    );

    // We don't need to show error messages here because
    // `findSDKConfigForDebugSession` does that.
    if (!sdk) {
      this.logger.error("Couldn't find an SDK for the debug session");
      return undefined;
    }
    this.logger.info(`Using the SDK ${sdk.version} for the debug session`);

    this.logger.debug('env', sdk.getProcessEnv());

    return new vscode.DebugAdapterExecutable(
      sdk.dapPath,
      ['--repl-mode', 'variable'],
      {
        env: sdk.getProcessEnv(),
      },
    );
  }
}

/**
 * This class defines a factory used to for mojo-cuda-gdb.
 */
class MojoCudaGdbDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  async createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: Optional<vscode.DebugAdapterExecutable>,
  ): Promise<Optional<vscode.DebugAdapterDescriptor>> {
    // We never actually call this, but we need a stub for registration.
    // Instead of making a DebugAdapterDescriptor, we end up tossing the
    // configuration to the Nsight extension by rewriting to their config.
    return undefined;
  }
}

/**
 * This class modifies the debug configuration right before the debug adapter is
 * launched. In other words, this is where we configure lldb-vscode.
 */
class MojoDebugConfigurationResolver
  implements vscode.DebugConfigurationProvider
{
  private envManager: PythonEnvironmentManager;
  private logger: Logger;

  constructor(envManager: PythonEnvironmentManager, logger: Logger) {
    this.envManager = envManager;
    this.logger = logger;
  }

  async resolveDebugConfigurationWithSubstitutedVariables?(
    _folder: Optional<vscode.WorkspaceFolder>,
    debugConfiguration: MojoDebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<undefined | vscode.DebugConfiguration> {
    const sdk = await findSDKForDebugConfiguration(
      debugConfiguration,
      this.envManager,
    );
    // We don't need to show error messages here because
    // `findSDKConfigForDebugSession` does that.
    if (!sdk) {
      return undefined;
    }

    if (typeof debugConfiguration.pid === 'string') {
      debugConfiguration.pid = parseInt(debugConfiguration.pid);
    }

    if (debugConfiguration.mojoFile) {
      // Wheel environments do not ship a modular.cfg file that we can use to
      // invoke 'mojo run' directly. They instead use a wrapper, which can't be
      // launched under lldb. It's technically possible to launch the underlying
      // binary directly, but without a modular.cfg file we would need to set a
      // number of environment variables. We choose not to do that and instead
      // just disallow debugging a specific file when the SDK is installed via a
      // Python wheel.
      if (!sdk.supportsFileDebug) {
        this.logger.error(
          `Cannot launch debug session with mojoFile specified (was '${debugConfiguration.mojoFile}') because MAX was installed as a wheel.`,
        );
        vscode.window.showErrorMessage(
          "Debugging a Mojo file using the 'mojoFile' option is not supported when the Mojo SDK is installed as a wheel.",
        );
        return undefined;
      }

      if (
        !debugConfiguration.mojoFile.endsWith('.🔥') &&
        !debugConfiguration.mojoFile.endsWith('.mojo')
      ) {
        const message = `Mojo Debug error: the file '${
          debugConfiguration.mojoFile
        }' doesn't have the .🔥 or .mojo extension.`;
        this.logger.error(message);
        vscode.window.showErrorMessage(message);
        return undefined;
      }
      debugConfiguration.args = [
        'run',
        '--no-optimization',
        '--debug-level',
        'full',
        ...(debugConfiguration.buildArgs || []),
        debugConfiguration.mojoFile,
        ...(debugConfiguration.args || []),
      ];
      debugConfiguration.program = sdk.mojoPath;
    }

    // We give preference to the init commands specified by the user.
    // The timeout that will be used by LLDB when initializing the target in
    // different scenarios. We use 5 minutes as a very conservative timeout when
    // debugging massive LLVM targets.
    const initializationTimeoutSec = 5 * 60;

    if (debugConfiguration.customFrameFormat === undefined) {
      // FIXME(#23274): include {${function.is-optimized} [opt]} when we don't
      // emit opt for -O0.
      debugConfiguration.customFrameFormat =
        '${function.name-with-args}{${frame.is-artificial} [artificial]}';
    }

    if (debugConfiguration.enableSyntheticChildDebugging === undefined) {
      debugConfiguration.enableSyntheticChildDebugging = true;
    }

    // This setting indicates LLDB to generate a useful summary for each
    // non-primitive type that is displayed right away in the IDE.
    if (debugConfiguration.enableAutoVariableSummaries === undefined) {
      debugConfiguration.enableAutoVariableSummaries = true;
    }

    // This setting indicates LLDB to use the `:` prefix in the Debug Console to
    // disambiguate variable printing from regular LLDB commands.
    if (debugConfiguration.commandEscapePrefix === undefined) {
      debugConfiguration.commandEscapePrefix = ':';
    }

    // This timeout affects targets created with "attachCommands" or
    // "launchCommands".
    if (debugConfiguration.timeout === undefined) {
      debugConfiguration.timeout = initializationTimeoutSec;
    }

    // This setting shortens the length of address strings.
    const initCommands = [
      `?!plugin load '${sdk.lldbPluginPath}'`,
      '?settings set target.show-hex-variable-values-with-leading-zeroes false',
      // FIXME(#23274): remove this when we properly emit the opt flag.
      '?settings set target.process.optimization-warnings false',
      '?mojo statistics telemetry session.start vscode',
    ];

    debugConfiguration.initCommands = [
      ...initCommands,
      ...(debugConfiguration.initCommands || []),
    ];

    // Pull in the additional visualizers within the lldb-visualizers dir.
    if (await sdk.lldbHasPythonScriptingSupport()) {
      const visualizersDir = sdk.visualizersPath;
      const visualizers = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(visualizersDir),
      );
      const visualizerCommands = visualizers.map(
        ([name, _type]) => `?command script import ${visualizersDir}/${name}`,
      );
      debugConfiguration.initCommands.push(...visualizerCommands);
    }

    const env = [
      `LLDB_VSCODE_RIT_TIMEOUT_IN_MS=${initializationTimeoutSec * 1000}`, // runInTerminal initialization timeout.
      ...envDictToList(sdk.getProcessEnv()),
    ];

    debugConfiguration.env = [...env, ...(debugConfiguration.env || [])];
    return debugConfiguration as vscode.DebugConfiguration;
  }

  async resolveDebugConfiguration(
    _folder: Optional<vscode.WorkspaceFolder>,
    debugConfiguration: MojoDebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration> {
    // The `Debug: Start Debugging` command (aka F5 or the `Run and Debug`
    // button if no launch.json files are present), invoke this method with a
    // totally empty debugConfiguration, so we have to fill it in.
    if (!debugConfiguration.request) {
      debugConfiguration.type = DEBUG_TYPE;
      debugConfiguration.request = 'launch';
      // This will get replaced with the currently active document.
      debugConfiguration.mojoFile = '${file}';
    }

    return debugConfiguration as vscode.DebugConfiguration;
  }
}

/**
 * This class modifies the debug configuration right before the debug adapter is
 * launched. This is where we mutate the mojo-cuda-gdb config into normal
 * cuda-gdb config.
 */
class MojoCudaGdbDebugConfigurationResolver
  implements vscode.DebugConfigurationProvider
{
  private envManager: PythonEnvironmentManager;
  private logger: Logger;

  constructor(envManager: PythonEnvironmentManager, logger: Logger) {
    this.envManager = envManager;
    this.logger = logger;
  }

  async resolveDebugConfigurationWithSubstitutedVariables?(
    _folder: Optional<vscode.WorkspaceFolder>,
    debugConfigIn: MojoCudaGdbDebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<undefined | vscode.DebugConfiguration> {
    const maybeErrorMessage = await checkNsightInstall(this.logger);
    if (maybeErrorMessage) {
      return undefined;
    }

    // relax the debugConfig.args type
    const debugConfig = debugConfigIn as vscode.DebugConfiguration;
    let args = debugConfigIn.args || [];

    const sdk = await findSDKForDebugConfiguration(
      debugConfigIn as vscode.DebugConfiguration,
      this.envManager,
    );
    // We don't need to show error messages here because
    // `findSDKConfigForDebugSession` does that.
    if (!sdk) {
      return undefined;
    }
    // If we have a mojoFile config, translate it to program plus args.
    if (debugConfigIn.mojoFile) {
      debugConfig.program = sdk.mojoPath;
      args = [
        'run',
        '--no-optimization',
        '--debug-level',
        'full',
        debugConfig.mojoFile,
        ...args,
      ];
    }

    // Transform debugConfig into normal cuda-gdb config.
    debugConfig.type = 'cuda-gdb';
    // cuda-gdb takes args as a single string, while we take them as an array.
    // Actually, cuda-gdb can take an array, which it then joins into a single
    // string separated by ";" characters. So it takes the list of program
    // arguments to the debuggee as a single string.
    debugConfig.args = quote(args || []);
    // cuda-gdb takes environment as a list of objects like:
    // [{"name": "HOME", "value": "/home/ubuntu"}]
    const env = debugConfigIn.env || [];
    debugConfig.environment = env.map((envStr: string) => {
      const split = envStr.split('=');
      return { name: split[0], value: split.slice(1).join('=') };
    });
    // Minor name changes between cuda-gdb and mojo-cuda-gdb...
    debugConfig.stopAtEntry = debugConfigIn.stopOnEntry;
    debugConfig.processId = debugConfigIn.pid;
    return debugConfig;
  }
}

/**
 * Provides debug configurations dynamically depending on the currently open
 * workspaces and files.
 */
class MojoDebugDynamicConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  async provideDebugConfigurations(
    _folder: Optional<vscode.WorkspaceFolder>,
    _token?: Optional<vscode.CancellationToken>,
  ): Promise<Optional<vscode.DebugConfiguration[]>> {
    const [activeFile, otherOpenFiles] = getAllOpenMojoFiles();
    return [activeFile, ...otherOpenFiles]
      .filter((file): file is WorkspaceAwareFile => !!file)
      .map((file) => {
        return {
          type: DEBUG_TYPE,
          request: 'launch',
          name: `Mojo: Debug ${file.baseName} ⸱ ${file.relativePath}`,
          mojoFile: file.uri.fsPath,
          args: [],
          env: [],
          cwd: file.workspaceFolder?.uri.fsPath,
          runInTerminal: false,
        };
      });
  }
}

/**
 * Class used to register and manage all the necessary constructs to support
 * mojo debugging.
 */
export class MojoDebugManager extends DisposableContext {
  private envManager: PythonEnvironmentManager;

  constructor(extension: MojoExtension, envManager: PythonEnvironmentManager) {
    super();
    this.envManager = envManager;

    // Register the lldb-vscode debug adapter.
    this.pushSubscription(
      vscode.debug.registerDebugAdapterDescriptorFactory(
        DEBUG_TYPE,
        new MojoDebugAdapterDescriptorFactory(
          this.envManager,
          extension.logger,
        ),
      ),
    );

    this.pushSubscription(
      vscode.debug.onDidStartDebugSession(async (listener) => {
        if (listener.configuration.type != DEBUG_TYPE) {
          return;
        }

        if (!listener.configuration.runInTerminal) {
          await vscode.commands.executeCommand('workbench.view.debug');
          await vscode.commands.executeCommand(
            'workbench.debug.action.focusRepl',
          );
        }
      }),
    );

    this.pushSubscription(initializeInlineLocalVariablesProvider(extension));

    this.pushSubscription(
      vscode.debug.registerDebugConfigurationProvider(
        DEBUG_TYPE,
        new MojoDebugConfigurationResolver(envManager, extension.logger),
      ),
    );

    this.pushSubscription(
      vscode.debug.registerDebugConfigurationProvider(
        DEBUG_TYPE,
        new MojoDebugDynamicConfigurationProvider(),
        vscode.DebugConfigurationProviderTriggerKind.Dynamic,
      ),
    );

    this.pushSubscription(
      activatePickProcessToAttachCommand(extension.extensionContext),
    );

    this.pushSubscription(
      vscode.commands.registerCommand('mojo.debug.attach-to-process', () => {
        return vscode.debug.startDebugging(undefined, {
          type: 'mojo-lldb',
          request: 'attach',
          name: 'Mojo: Attach to process command',
          pid: '${command:pickProcessToAttach}',
        });
      }),
    );

    // Add subscriptions for mojo-cuda-gdb.  Need to register
    // DAPDescriptorFactory, but all of the real work is handled by
    // registerDebugConfigurationProvider, which translates the config to
    // Nsight's cuda-gdb format, ultimately launching its debugger instead.
    this.pushSubscription(
      vscode.debug.registerDebugAdapterDescriptorFactory(
        'mojo-cuda-gdb',
        new MojoCudaGdbDebugAdapterDescriptorFactory(),
      ),
    );

    this.pushSubscription(
      vscode.debug.registerDebugConfigurationProvider(
        'mojo-cuda-gdb',
        new MojoCudaGdbDebugConfigurationResolver(envManager, extension.logger),
      ),
    );
  }
}
