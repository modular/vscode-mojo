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
import { Logger } from './logging';
import path from 'path';
import * as util from 'util';
import {
  execFile as callbackExecFile,
  exec as callbackExec,
} from 'child_process';
import { Memoize } from 'typescript-memoize';
import { TelemetryReporter } from './telemetry';
import { directoryExists, fileExists } from './utils/files';
import * as config from './utils/config';
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

export type OverridePathState = 'unset' | 'valid' | 'invalid';

export class PythonEnvironmentManager extends DisposableContext {
  private api: PythonExtension | undefined = undefined;
  private logger: Logger;
  private reporter: TelemetryReporter;
  public onEnvironmentChange: vscode.Event<void>;
  private envChangeEmitter: vscode.EventEmitter<void>;
  private displayedSDKError: boolean = false;
  private lastLoadedEnv: string | undefined = undefined;
  private activeSDK: SDK | undefined = undefined;
  /// Filesystem path of the Python extension's active environment at the
  /// time the active SDK was detected, recorded only when it differs from
  /// the env that produced the SDK. `undefined` means no divergence.
  private pickerEnvPathAtDetection: string | undefined = undefined;
  private overridePathState: OverridePathState = 'unset';
  private sdkPathChangeTimer: NodeJS.Timeout | undefined = undefined;
  /// Subscription to Python extension env-discovery changes. Created lazily
  /// while we have no SDK and an open `.mojo` file (so we pick up a pixi env
  /// that appears mid-session). Disposed once an SDK is found.
  private envDiscoverySubscription: vscode.Disposable | undefined = undefined;

  constructor(logger: Logger, reporter: TelemetryReporter) {
    super();
    this.logger = logger;
    this.reporter = reporter;
    this.envChangeEmitter = new vscode.EventEmitter();
    this.onEnvironmentChange = this.envChangeEmitter.event;
  }

  public async init() {
    await this.tryInitApi();
    // Watch for the Python extension being installed/enabled mid-session so
    // we can pick it up without requiring a window reload.
    this.pushSubscription(
      vscode.extensions.onDidChange(() => this.handleExtensionChange()),
    );
    // Debounce sdk.path edits so we don't thrash detection while the user is
    // mid-typing in the Settings GUI. Also reacts to preferPixiEnv toggles,
    // which can flip whether the workspace pixi env wins over the Python
    // extension's active interpreter.
    this.pushSubscription(
      vscode.workspace.onDidChangeConfiguration((event) => {
        const sdkPathChanged = event.affectsConfiguration('mojo.sdk.path');
        const preferPixiChanged =
          event.affectsConfiguration('mojo.preferPixiEnv');
        if (!sdkPathChanged && !preferPixiChanged) {
          return;
        }
        if (this.sdkPathChangeTimer) {
          clearTimeout(this.sdkPathChangeTimer);
        }
        // Only sdk.path needs debouncing (user types into a text field);
        // preferPixiEnv is a checkbox so a 0ms delay would also work, but
        // the unified debounce simplifies the lifecycle.
        this.sdkPathChangeTimer = setTimeout(() => {
          this.sdkPathChangeTimer = undefined;
          this.logger.info(
            'SDK-related setting changed, refreshing SDK detection',
          );
          this.refresh();
        }, 1500);
      }),
    );
    this.pushSubscription(
      new vscode.Disposable(() => {
        if (this.sdkPathChangeTimer) {
          clearTimeout(this.sdkPathChangeTimer);
        }
      }),
    );
  }

  /// Invalidate the cached SDK and notify subscribers, so the next lookup
  /// re-runs detection. Used both by the sdk.path setting watcher and by the
  /// `mojo.sdk.refresh` command surfaced on the SDK status bar.
  public refresh() {
    this.activeSDK = undefined;
    this.pickerEnvPathAtDetection = undefined;
    this.displayedSDKError = false;
    this.envChangeEmitter.fire();
  }

  private async tryInitApi() {
    if (this.api) {
      return;
    }
    if (!vscode.extensions.getExtension('ms-python.python')) {
      this.logger.warn(
        'The Python extension is not installed. ' +
          'Install the Python extension (ms-python.python) to enable automatic SDK discovery.',
      );
      return;
    }
    try {
      this.api = await PythonExtension.api();
    } catch (e) {
      this.logger.warn('Failed to load the Python extension API:', e);
      return;
    }
    this.pushSubscription(
      this.api.environments.onDidChangeActiveEnvironmentPath((p) =>
        this.handleEnvironmentChange(p.path),
      ),
    );
  }

  private async handleExtensionChange() {
    if (this.api) {
      return;
    }
    if (!vscode.extensions.getExtension('ms-python.python')) {
      return;
    }
    this.logger.info(
      'Python extension became available, initializing SDK discovery.',
    );
    await this.tryInitApi();
    if (this.api) {
      this.refresh();
    }
  }

  private async handleEnvironmentChange(newEnv: string) {
    this.logger.debug(
      `Active environment path change: ${newEnv} (current: ${this.lastLoadedEnv})`,
    );
    if (newEnv != this.lastLoadedEnv) {
      this.logger.info('Python environment has changed, reloading SDK');
      this.refresh();
    }
  }

  /// Whether the Python extension API is available. Used by the status bar to
  /// distinguish "no SDK found" from "Python extension not installed".
  public isPythonExtensionAvailable(): boolean {
    return this.api !== undefined;
  }

  /// State of the `mojo.sdk.path` override setting. Used by the status bar to
  /// distinguish "user set an invalid override path" from other failure modes.
  public getOverridePathState(): OverridePathState {
    return this.overridePathState;
  }

  /// Finds the active SDK, in priority order:
  /// 1. `mojo.sdk.path` override (if set; fails loudly without falling back)
  /// 2. Monorepo `.derived/` SDK
  /// 3. Workspace pixi env (gated on `mojo.preferPixiEnv`)
  /// 4. SDK from the active Python extension environment
  public async findActiveSDK(): Promise<SDK | undefined> {
    // 1. User-supplied override path beats every other source. If it's set
    // but doesn't resolve, do NOT fall back — that would silently violate
    // the override semantics. The status bar surfaces the failure instead.
    const overrideSDK = await this.tryGetOverrideSDK();
    if (overrideSDK) {
      return overrideSDK;
    }
    if (this.overridePathState === 'invalid') {
      return undefined;
    }

    // 2. Monorepo SDK — works without the Python extension.
    const monorepoSDK = await this.tryGetMonorepoSDK();

    if (monorepoSDK) {
      this.logger.info(
        'Monorepo SDK found, prioritizing that over Python environment.',
      );
      return monorepoSDK;
    }

    if (!this.api) {
      this.logger.warn(
        'Cannot discover SDK: the Python extension (ms-python.python) is not installed.',
      );
      return undefined;
    }

    // 3. Workspace pixi env with `pixi add mojo`. Prefers a workspace-local
    // pixi env over whatever the Python extension's interpreter picker has
    // selected, because the picker's heuristics aren't pixi-aware and often
    // pick a system or homebrew Python by default.
    const pixiSDK = await this.tryGetPixiSDK();
    if (pixiSDK) {
      this.logger.info('Using workspace pixi env for Mojo SDK detection.');
      return pixiSDK;
    }

    // 4. Whatever the Python extension reports as the active environment.
    const envPath = this.api.environments.getActiveEnvironmentPath();
    const env = await this.api.environments.resolveEnvironment(envPath);
    this.logger.info('Loading MAX SDK information from Python environment');
    this.lastLoadedEnv = envPath.path;

    if (!env) {
      this.logger.error(
        'No Python environment could be retrieved from the Python extension.',
      );
      // The SDK status bar surfaces "Mojo: No SDK" with diagnostic info in
      // the tooltip; a transient toast on top of that is redundant noise.
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
    return this.createSDKFromWheelLayout(
      env.executable.sysPrefix,
      env.version!.major,
      env.version!.minor,
      SDKKind.Environment,
    );
  }

  /// Create an SDK from a wheel-style layout rooted at `sysPrefix`, given
  /// a known Python major/minor version. Used both for Python-extension envs
  /// and user-supplied override paths.
  private async createSDKFromWheelLayout(
    sysPrefix: string,
    pythonMajor: number,
    pythonMinor: number,
    kind: SDKKind,
  ): Promise<SDK | undefined> {
    const binPath = path.join(sysPrefix, 'bin');
    const libPath = path.join(
      sysPrefix,
      'lib',
      `python${pythonMajor}.${pythonMinor}`,
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
      kind,
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

  /// Attempt to load an SDK from the user-supplied `mojo.sdk.path` setting.
  /// Updates `overridePathState` as a side effect so callers can distinguish
  /// "no override set" from "override set but unusable".
  private async tryGetOverrideSDK(): Promise<SDK | undefined> {
    const overridePath = config.get<string>('sdk.path', undefined)?.trim();
    if (!overridePath) {
      this.overridePathState = 'unset';
      return undefined;
    }

    this.logger.info(`Loading SDK from override path: ${overridePath}`);

    if (!(await directoryExists(overridePath))) {
      this.logger.error(
        `Override path '${overridePath}' does not exist or is not a directory.`,
      );
      this.overridePathState = 'invalid';
      return undefined;
    }

    // Try the conda/pixi layout first: <override>/share/max/modular.cfg
    const homePath = path.join(overridePath, 'share', 'max');
    if (await fileExists(path.join(homePath, 'modular.cfg'))) {
      const sdk = await this.createSDKFromHomePath(
        SDKKind.Custom,
        homePath,
        overridePath,
      );
      this.overridePathState = sdk ? 'valid' : 'invalid';
      return sdk;
    }

    // Fall back to the wheel layout: <override>/lib/python<X>.<Y>/site-packages/modular/...
    const pythonVersion = await this.detectPythonVersion(overridePath);
    if (pythonVersion) {
      const [major, minor] = pythonVersion;
      const sdk = await this.createSDKFromWheelLayout(
        overridePath,
        major,
        minor,
        SDKKind.Custom,
      );
      this.overridePathState = sdk ? 'valid' : 'invalid';
      return sdk;
    }

    this.logger.error(
      `Override path '${overridePath}' contains neither a 'share/max/modular.cfg' file nor a 'lib/python*' directory.`,
    );
    this.overridePathState = 'invalid';
    return undefined;
  }

  /// Find a `python<major>.<minor>` directory under `<root>/lib`, returning
  /// the parsed version. Used to resolve wheel-style install paths whose
  /// Python version we can't query directly (no Python extension available).
  private async detectPythonVersion(
    root: string,
  ): Promise<[number, number] | undefined> {
    const libDir = path.join(root, 'lib');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(
        vscode.Uri.file(libDir),
      );
    } catch {
      return undefined;
    }
    for (const [name, type] of entries) {
      if (!(type & vscode.FileType.Directory)) {
        continue;
      }
      const match = name.match(/^python(\d+)\.(\d+)$/);
      if (match) {
        return [parseInt(match[1], 10), parseInt(match[2], 10)];
      }
    }
    return undefined;
  }

  /// Attempt to load a Mojo SDK from a workspace-local pixi environment
  /// (`<workspace>/.pixi/envs/*` containing `share/max/modular.cfg`). Returns
  /// undefined if `mojo.preferPixiEnv` is disabled, no Python extension API
  /// is available, no workspace folders are open, or no matching env contains
  /// a valid SDK. Pixi envs are identified by path pattern rather than the
  /// Python extension's `tools` tag — `KnownEnvironmentTools` does not
  /// include 'Pixi'.
  private async tryGetPixiSDK(): Promise<SDK | undefined> {
    const preferPixi = config.get<boolean>(
      'preferPixiEnv',
      /*workspaceFolder=*/ undefined,
      true,
    );
    if (!preferPixi) {
      return undefined;
    }
    if (!this.api) {
      return undefined;
    }
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }

    const pixiPathFragment = `${path.sep}.pixi${path.sep}envs${path.sep}`;
    const workspacePrefixes = workspaceFolders.map((f) => f.uri.fsPath);

    const candidates = this.api.environments.known.filter((env) => {
      const folderPath = env.environment?.folderUri.fsPath;
      if (!folderPath || !folderPath.includes(pixiPathFragment)) {
        return false;
      }
      return workspacePrefixes.some((prefix) => folderPath.startsWith(prefix));
    });

    if (candidates.length === 0) {
      return undefined;
    }

    // Prefer the env named "default" (pixi's convention), then alphabetical
    // by env folder name. Users with multi-env pixi setups who want a
    // non-default env should use `mojo.sdk.path`.
    candidates.sort((a, b) => {
      const nameA = path.basename(a.environment!.folderUri.fsPath);
      const nameB = path.basename(b.environment!.folderUri.fsPath);

      if (nameA === 'default' && nameB !== 'default') {
        return -1;
      }

      if (nameB === 'default' && nameA !== 'default') {
        return 1;
      }
      return nameA.localeCompare(nameB);
    });

    for (const candidate of candidates) {
      const resolved =
        await this.api.environments.resolveEnvironment(candidate);
      if (!resolved) {
        continue;
      }
      if (!(await this.envHasModularCfg(resolved))) {
        continue;
      }
      const sdk = await this.createSDKFromHomePath(
        SDKKind.Environment,
        path.join(resolved.executable.sysPrefix, 'share', 'max'),
        resolved.executable.sysPrefix,
      );
      if (!sdk) {
        continue;
      }

      // Record divergence (if any) between the pixi env we chose and the
      // Python extension's active interpreter. The status bar surfaces this
      // in the tooltip so the user understands why the picker selection
      // isn't being honored for SDK lookup.
      const pickerPath = this.api.environments.getActiveEnvironmentPath();
      const pickerResolved =
        await this.api.environments.resolveEnvironment(pickerPath);
      const pickerSysPrefix = pickerResolved?.executable.sysPrefix;
      if (
        pickerSysPrefix &&
        pickerSysPrefix !== resolved.executable.sysPrefix
      ) {
        this.pickerEnvPathAtDetection = pickerSysPrefix;
      }

      this.logger.info(
        `Found workspace pixi env with Mojo SDK at ${
          resolved.environment?.folderUri.fsPath
        }`,
      );
      return sdk;
    }

    return undefined;
  }

  /// Returns the Python extension's active environment path if it differs
  /// from the env that produced the currently active SDK, otherwise
  /// undefined. Used by the SDK status bar to render a divergence note.
  public getPickerEnvPathIfDivergent(): string | undefined {
    return this.pickerEnvPathAtDetection;
  }

  /// Subscribe to `onDidChangeEnvironments` only while there is no active
  /// SDK. Called by `MojoLSPManager.tryStartLanguageClient` when a `.mojo`
  /// file is opened but detection fails — that's the only situation where
  /// we want to react to env-list changes (e.g., the user just ran
  /// `pixi add mojo` mid-session and we want to pick it up).
  public watchForEnvDiscoveryIfNeeded() {
    if (this.activeSDK) {
      // Already have an SDK; drop any subscription that was active.
      this.envDiscoverySubscription?.dispose();
      this.envDiscoverySubscription = undefined;
      return;
    }
    if (this.envDiscoverySubscription || !this.api) {
      return;
    }

    const pixiPathFragment = `${path.sep}.pixi${path.sep}envs${path.sep}`;
    const workspacePrefixes =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];

    this.envDiscoverySubscription =
      this.api.environments.onDidChangeEnvironments((event) => {
        // Filter to env changes that affect a workspace pixi env. Avoids
        // thrashing detection on irrelevant changes like system Python
        // being indexed.
        const folderPath = event.env.environment?.folderUri.fsPath;
        if (!folderPath?.includes(pixiPathFragment)) {
          return;
        }
        if (
          !workspacePrefixes.some((prefix) => folderPath.startsWith(prefix))
        ) {
          return;
        }
        this.logger.info(
          `Workspace pixi env ${event.type} at ${folderPath}, ` +
            'refreshing SDK detection',
        );
        this.refresh();
      });
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
