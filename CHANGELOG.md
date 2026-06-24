# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This changelog relates to the VS Code Extension for the Mojo language. Changelogs for the Mojo project can be found at: [Mojo release changelog](https://docs.modular.com/mojo/changelog)

## [26.6.0] - 2026-06-24

- Added: Workspace Python venvs (`.venv` containing `bin/mojo`, e.g. from `uv pip install modular`) are now detected as a Mojo SDK source, alongside the existing pixi env detection (#203)
- Added: `mojo.preferWorkspaceEnv` setting generalizes the previous `mojo.preferPixiEnv` to cover both pixi envs and Python venvs. The old setting is honored as a deprecated alias (#203)
- Change: Debugging a Mojo file now compiles it ahead-of-time with `mojo build` and attaches LLDB to the produced binary, rather than running it via `mojo run` under LLDB. Crashes in user code are no longer confused with compilation errors, and debugging now works in wheel-installed Mojo SDKs (#192)
- Change: The LSP status bar item now distinguishes a stopped-after-repeated-crashes state from a normal stopped state, and clicking restart from that state no longer errors out (#204)

## [26.5.1] - 2026-06-08

- Fix: Workspace pixi SDK detection now attempts a direct filesystem scan rather than initially depending on the Python extension for discovery (#184)
- Removed: The `>` glyph decoration previously inserted before lines inside Mojo fenced code blocks (#190)
- Change: README now documents the VS Code configuration for `editor.formatOnSave` with `.mojo` files (#185) - Thanks @kgcodex!

## [26.5.0] - 2026-05-25

- Added: Workspace pixi environments (`.pixi/envs/*` containing `share/max/modular.cfg`) are now preferred over the Python extension's active interpreter for Mojo SDK detection (#168)
- Added: `mojo.preferPixiEnv` setting to disable pixi preference for users who want the Python interpreter picker to remain the authoritative source (#168)
- Change: Removed the redundant "Unable to load a Python environment" toast on SDK detection failure; the SDK status bar tooltip now lists the detection sources in priority order (#168)

## [26.4.0] - 2026-05-12

- Added: LSP status bar item showing language server state with click-to-restart (#155)
- Added: `mojo.sdk.path` setting for manual SDK override (#123)
- Added: `Mojo: Refresh SDK Detection` command (#155)
- Change: Python extension (`ms-python.python`) is now a soft dependency, hopefully resolving installation issues in Cursor (#123)
- Change: LSP server is now invoked directly via stdio; the previous `lsp-proxy` IPC bridge has been removed (#155)
- Change: Changes to `mojo.sdk.path` now apply automatically rather than via a reload prompt (#155)

## [26.3.0] - 2026-05-05

- Added: SDK status bar item that shows the detected Mojo SDK version, or a clickable warning if no SDK was found (#152)
- Change: Updated function modifier syntax from `owned` to `var` (#117)
- Fix: Allow `mojo.lsp.includeDirs` to be set at workspace level (#145)
- Fix: Add `buildArgs` to `mojo-lldb` debug configuration schema (#146)

## [26.2.0] - 2026-01-27

- Added: New command that stops the LSP server (#36) - Thanks @mzaks!
- Fix: Corrected date of 26.1.0 release (#55)

## [26.1.0] - 2026-01-26

- Added: Option to filter out diagnostics in docstrings (#38) - Thanks @mzaks!
- Fix: Cache active SDK to avoid redundant lookups (#41)

## [26.0.3] - 2025-12-05

- Fix: Resolve remaining issues with `CONDA_PREFIX` that prevented use of `mojo debug --vscode` (#33)

## [26.0.2] - 2025-12-03

- Change: Improvements to README (#30)
- Change: Added `comptime` keyword syntax support (#32)
- Fix: Debugger fails to launch in some environments due to issues with `CONDA_PREFIX` (#28)
- Fix: Incorrect install link in README (#27)

## [26.0.1] - 2025-09-29

- Change: Added LICENSE file

## [26.0.0] - 2025-09-22

Moved extension to standalone repository with independent release schedule
