import * as vscode from 'vscode';

import { Logger } from './../logging';
import { quote } from 'shell-quote';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PythonEnvironmentManager } from '../pyenv';

const execAsync = promisify(exec);

/**
 * Sets up a workspace with Pixi package manager for Mojo development.
 *
 * This function performs the following steps:
 * 1. Checks if Pixi is installed, installs it if missing
 * 2. Initializes a Pixi project with Mojo-compatible channels if pixi.toml doesn't exist
 * 3. Adds the Mojo package if not already present
 * 4. Configures the Python environment to use Pixi's Python interpreter
 *
 * @param logger - Logger instance for debugging and tracking progress
 * @param pyenvManager - Optional Python environment manager to configure the interpreter path
 * @returns Promise that resolves when setup is complete
 *
 * @example
 * ```typescript
 * await setupWorkspaceWithPixi(logger, pyenvManager);
 * ```
 */
export async function setupWorkspaceWithPixi(
  logger: Logger,
  pyenvManager?: PythonEnvironmentManager,
): Promise<void> {
  logger.debug('Init pixi project');

  if ((await isPixiInstalled()) === false) {
    logger.debug('Need to install pixi first');
    await runTaskAndWait(
      'curl -fsSL https://pixi.sh/install.sh | bash',
      'Install Pixi',
    );
  }

  if ((await vscode.workspace.findFiles('pixi.toml')).length === 0) {
    await runTaskAndWait(
      quote([
        'pixi',
        'init',
        '-c',
        'https://conda.modular.com/max-nightly/',
        '-c',
        'conda-forge',
      ]),
      'Pixi init',
    );
  }

  if ((await vscode.workspace.findFiles('.pixi/**/mojo')).length === 0) {
    await runTaskAndWait(quote(['pixi', 'add', 'mojo']), 'Adding Mojo');
  }

  const pythonInterpreterPaths =
    await vscode.workspace.findFiles('.pixi/**/python');
  if (pythonInterpreterPaths.length === 1) {
    pyenvManager?.setPythonEnv(pythonInterpreterPaths[0].fsPath);
  }
}

/**
 * Checks if Pixi package manager is installed on the system.
 *
 * Attempts to execute `pixi --version` to verify installation.
 *
 * @returns Promise resolving to true if Pixi is installed, false otherwise
 *
 * @example
 * ```typescript
 * if (await isPixiInstalled()) {
 *   console.log('Pixi is available');
 * }
 * ```
 */
async function isPixiInstalled(): Promise<boolean> {
  try {
    // Try to run pixie with a version or help flag
    await execAsync('pixi --version', {
      shell: '/bin/bash',
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.pixi/bin:${process.env.PATH}`,
      },
    });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Executes a shell command as a VS Code task and waits for completion.
 *
 * Creates and runs a workspace-scoped shell task, monitoring it until completion.
 * The task is visible in VS Code's task output panel.
 *
 * @param command - The shell command to execute
 * @param name - Display name for the task in VS Code's task list
 * @returns Promise resolving to true if the task succeeded (exit code 0), false otherwise
 *
 * @example
 * ```typescript
 * const success = await runTaskAndWait('npm install', 'Install Dependencies');
 * if (success) {
 *   console.log('Installation completed successfully');
 * }
 * ```
 */
async function runTaskAndWait(command: string, name: string): Promise<boolean> {
  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.pixi/bin:${process.env.PATH}`,
  };
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    name,
    'Mojo Extension',
    new vscode.ShellExecution(command, {
      env: env,
      executable: '/bin/bash', // Explicitly use bash
      shellArgs: ['-c'],
    }),
  );

  const execution = await vscode.tasks.executeTask(task);

  return new Promise((resolve) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        disposable.dispose();
        resolve(e.exitCode === 0);
      }
    });
  });
}
