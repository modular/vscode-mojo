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
import * as ini from 'ini';
import { DisposableContext } from './utils/disposableContext';
import { PythonExtension, ResolvedEnvironment } from '@vscode/python-extension';
import assert from 'assert';
import { Logger } from './logging';
import path from 'path';
import * as util from 'util';
import {
  execFile as callbackExecFile,
  exec as callbackExec,
} from 'child_process';
import { Memoize } from 'typescript-memoize';
import { TelemetryReporter } from './telemetry';
import { fileExists } from './utils/files';
const execFile = util.promisify(callbackExecFile);
const exec = util.promisify(callbackExec);

export enum SDKKind {
  Environment = 'environment',
  Custom = 'custom',
  Internal = 'internal',
}

/// Represents a usable instance of the MAX SDK.
export class SDK {
  public readonly supportsFileDebug: boolean = false;

  constructor(
    private logger: Logger,
    /// What kind of SDK this is. Primarily used for logging and context hinting.
    readonly kind: SDKKind,
    /// The unparsed version string of the SDK.
    readonly version: string,
    /// The path to the language server executable.
    readonly lspPath: string,
    /// The path to the mblack executable.
    readonly mblackPath: string,
    /// The path to the Mojo LLDB plugin.
    readonly lldbPluginPath: string,
    /// The path to the DAP server executable.
    readonly dapPath: string,
    /// The path to the Mojo executable.
    readonly mojoPath: string,
    /// The path to the directory containing LLDB debug visualizers.
    readonly visualizersPath: string,
    /// The path to the LLDB executor.
    readonly lldbPath: string,
  ) {}

  @Memoize()
  /// Checks if the version of LLDB shipped with this SDK supports Python scripting.
  public async lldbHasPythonScriptingSupport(): Promise<boolean> {
    try {
      let { stdout, stderr } = await execFile(this.lldbPath, [
        '-b',
        '-o',
        'script print(100+1)',
      ]);
      stdout = (stdout || '') as string;
      stderr = (stderr || '') as string;

      if (stdout.indexOf('101') != -1) {
        this.logger.info('Python scripting support in LLDB found.');
        return true;
      } else {
        this.logger.info(
          `Python scripting support in LLDB not found. The test script returned:\n${
            stdout
          }\n${stderr}`,
        );
      }
    } catch (e) {
      this.logger.error(
        'Python scripting support in LLDB not found. The test script failed with',
        e,
      );
    }
    return false;
  }

  /// Gets an appropriate environment to spawn subprocesses from this SDK.
  public getProcessEnv(withTelemetry: boolean = true) {
    return {
      MODULAR_TELEMETRY_ENABLED: withTelemetry ? 'true' : 'false',
    };
  }
}

class HomeSDK extends SDK {
  public override readonly supportsFileDebug: boolean = true;

  constructor(
    logger: Logger,
    kind: SDKKind,
    version: string,
    private homePath: string,
    lspPath: string,
    mblackPath: string,
    lldbPluginPath: string,
    dapPath: string,
    mojoPath: string,
    visualizersPath: string,
    lldbPath: string,
    private prefixPath?: string,
  ) {
    super(
      logger,
      kind,
      version,
      lspPath,
      mblackPath,
      lldbPluginPath,
      dapPath,
      mojoPath,
      visualizersPath,
      lldbPath,
    );
  }

  public override getProcessEnv(withTelemetry: boolean = true) {
    return {
      ...super.getProcessEnv(withTelemetry),
      MODULAR_HOME: this.homePath,
      // HACK: Set CONDA_PREFIX to allow debugger wrappers to work
      CONDA_PREFIX: this.prefixPath,
    };
  }
}

export class PythonEnvironmentManager extends DisposableContext {
  private api: PythonExtension | undefined = undefined;
  private logger: Logger;
  private reporter: TelemetryReporter;
  public onEnvironmentChange: vscode.Event<void>;
  private envChangeEmitter: vscode.EventEmitter<void>;
  private displayedSDKError: boolean = false;
  private lastLoadedEnv: string | undefined = undefined;
  private activeSDK: SDK | undefined = undefined;

  constructor(logger: Logger, reporter: TelemetryReporter) {
    super();
    this.logger = logger;
    this.reporter = reporter;
    this.envChangeEmitter = new vscode.EventEmitter();
    this.onEnvironmentChange = this.envChangeEmitter.event;
  }

  public async init() {
    this.api = await PythonExtension.api();
    this.pushSubscription(
      this.api.environments.onDidChangeActiveEnvironmentPath((p) =>
        this.handleEnvironmentChange(p.path),
      ),
    );
  }

  private async handleEnvironmentChange(newEnv: string) {
    this.logger.debug(
      `Active environment path change: ${newEnv} (current: ${this.lastLoadedEnv})`,
    );
    if (newEnv != this.lastLoadedEnv) {
      this.logger.info('Python environment has changed, reloading SDK');
      this.envChangeEmitter.fire();
      this.displayedSDKError = false;
    }
  }

  /// Finds the active SDK from the currently active Python environment, or undefined if one is not present.
  public async findActiveSDK(): Promise<SDK | undefined> {
    assert(this.api !== undefined);
    // Prioritize retrieving a monorepo SDK over querying the environment.
    const monorepoSDK = await this.tryGetMonorepoSDK();

    if (monorepoSDK) {
      this.logger.info(
        'Monorepo SDK found, prioritizing that over Python environment.',
      );
      return monorepoSDK;
    }

    const envPath = this.api.environments.getActiveEnvironmentPath();
    const env = await this.api.environments.resolveEnvironment(envPath);
    this.logger.info('Loading MAX SDK information from Python environment');
    this.lastLoadedEnv = envPath.path;

    if (!env) {
      this.logger.error(
        'No Python enviroment could be retrieved from the Python extension.',
      );
      await this.displaySDKError(
        'Unable to load a Python enviroment from the VS Code Python extension.',
      );
      return undefined;
    }

    // We cannot use the environment type information reported by the Python
    // extension because it considers Conda and wheel-based installs to be the
    // same, when we need to differentiate them.
    this.logger.info(`Found Python environment at ${envPath.path}`, env);
    if (await this.envHasModularCfg(env)) {
      this.logger.info(
        `Python environment '${envPath.path}' appears to be Conda-like; using modular.cfg method.`,
      );
      return this.createSDKFromHomePath(
        SDKKind.Environment,
        path.join(env.executable.sysPrefix, 'share', 'max'),
        env.executable.sysPrefix,
      );
    } else {
      this.logger.info(
        `Python environment '${envPath.path}' does not have a modular.cfg file; assuming wheel installation.`,
      );
      return this.createSDKFromWheelEnv(env);
    }
  }

  /// Load the active SDK from the currently active Python environment, or undefined if one is not present.
  public async getActiveSDK(): Promise<SDK | undefined> {
    if (this.activeSDK) {
      return this.activeSDK;
    }
    this.activeSDK = await this.findActiveSDK();
    return this.activeSDK;
  }

  private async displaySDKError(message: string) {
    if (this.displayedSDKError) {
      return;
    }

    this.displayedSDKError = true;
    await vscode.window.showErrorMessage(message);
  }

  private async envHasModularCfg(env: ResolvedEnvironment): Promise<boolean> {
    return fileExists(
      path.join(env.executable.sysPrefix, 'share', 'max', 'modular.cfg'),
    );
  }

  private async createSDKFromWheelEnv(
    env: ResolvedEnvironment,
  ): Promise<SDK | undefined> {
    const binPath = path.join(env.executable.sysPrefix, 'bin');
    const libPath = path.join(
      env.executable.sysPrefix,
      'lib',
      `python${env.version!.major}.${env.version!.minor}`,
      'site-packages',
      'modular',
      'lib',
    );
    // helper to pull required files/folders out of the environment
    const retrievePath = async (target: string) => {
      this.logger.debug(`Retrieving tool path '${target}'.`);
      try {
        // stat-ing the path confirms it exists in some form; if an exception is thrown then it doesn't exist.
        await vscode.workspace.fs.stat(vscode.Uri.file(target));
        return target;
      } catch {
        this.logger.error(`Missing path ${target} in venv.`);
        return undefined;
      }
    };

    const libExt = process.platform == 'darwin' ? 'dylib' : 'so';

    const mojoPath = await retrievePath(path.join(binPath, 'mojo'));
    const lspPath = await retrievePath(path.join(binPath, 'mojo-lsp-server'));
    const lldbPluginPath = await retrievePath(
      path.join(libPath, `libMojoLLDB.${libExt}`),
    );
    const mblackPath = await retrievePath(path.join(binPath, 'mblack'));
    const dapPath = await retrievePath(path.join(binPath, 'lldb-dap'));
    const visualizerPath = await retrievePath(
      path.join(libPath, 'lldb-visualizers'),
    );
    const lldbPath = await retrievePath(path.join(binPath, 'mojo-lldb'));
    // The debugger requires that we avoid using the wrapped `mojo` entrypoint for specific scenarios.
    const rawMojoPath = await retrievePath(
      path.join(libPath, '..', 'bin', 'mojo'),
    );

    if (
      !mojoPath ||
      !lspPath ||
      !lldbPluginPath ||
      !rawMojoPath ||
      !mblackPath ||
      !lldbPluginPath ||
      !dapPath ||
      !visualizerPath ||
      !lldbPath
    ) {
      return undefined;
    }

    // We don't know the version intrinsically so we need to invoke it ourselves.
    const versionResult = await exec(`"${mojoPath}" --version`);
    return new SDK(
      this.logger,
      SDKKind.Environment,
      versionResult.stdout,
      lspPath,
      mblackPath,
      lldbPluginPath,
      dapPath,
      mojoPath,
      visualizerPath,
      lldbPath,
    );
  }

  /// Updates the active Python environment path if the provided path differs.
  public setPythonEnv(path: string) {
    if (path !== this.api?.environments.getActiveEnvironmentPath().path) {
      this.api?.environments.updateActiveEnvironmentPath(path);
    }
  }

  /// Attempts to create a SDK from a home path. Returns undefined if creation failed.
  public async createSDKFromHomePath(
    kind: SDKKind,
    homePath: string,
    prefixPath?: string,
  ): Promise<SDK | undefined> {
    const modularCfgPath = path.join(homePath, 'modular.cfg');
    const decoder = new TextDecoder();
    let bytes;
    try {
      bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.file(modularCfgPath),
      );
    } catch (e) {
      await this.displaySDKError(`Unable to read modular.cfg: ${e}`);
      this.logger.error('Error reading modular.cfg', e);
      return undefined;
    }

    let contents;
    try {
      contents = decoder.decode(bytes);
    } catch (e) {
      await this.displaySDKError(
        'Unable to decode modular.cfg; your MAX installation may be corrupted.',
      );
      this.logger.error('Error decoding modular.cfg bytes to string', e);
      return undefined;
    }

    let config;
    try {
      config = ini.parse(contents);
    } catch (e) {
      await this.displaySDKError(
        'Unable to parse modular.cfg; your MAX installation may be corrupted.',
      );
      this.logger.error('Error parsing modular.cfg contents as INI', e);
      return undefined;
    }

    try {
      const version = 'version' in config.max ? config.max.version : '0.0.0';
      this.logger.info(`Found SDK with version ${version}`);

      this.reporter.sendTelemetryEvent('sdkLoaded', {
        version,
        kind,
      });

      return new HomeSDK(
        this.logger,
        kind,
        version,
        homePath,
        config['mojo-max']['lsp_server_path'],
        config['mojo-max']['mblack_path'],
        config['mojo-max']['lldb_plugin_path'],
        config['mojo-max']['lldb_vscode_path'],
        config['mojo-max']['driver_path'],
        config['mojo-max']['lldb_visualizers_path'],
        config['mojo-max']['lldb_path'],
        prefixPath,
      );
    } catch (e) {
      await this.displaySDKError(
        'Unable to read a configuration key from modular.cfg; your MAX installation may be corrupted.',
      );
      this.logger.error('Error creating SDK from modular.cfg', e);
      return undefined;
    }
  }

  /// Attempt to load a monorepo SDK from the currently open workspace folder.
  /// Resolves with the loaded SDK, or undefined if one doesn't exist.
  private async tryGetMonorepoSDK(): Promise<SDK | undefined> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    if (vscode.workspace.workspaceFolders.length !== 1) {
      return;
    }

    const folder = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders[0].uri,
      '.derived',
    );
    try {
      const info = await vscode.workspace.fs.stat(folder);
      if (info.type & vscode.FileType.Directory) {
        return this.createSDKFromHomePath(SDKKind.Internal, folder.fsPath);
      }
    } catch {
      return undefined;
    }
  }
}
