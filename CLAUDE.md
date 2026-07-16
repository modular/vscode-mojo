# Mojo VS Code Extension

VS Code extension providing language support for Mojo: LSP integration,
debugger integration, and Mojo SDK detection for various install types.

## Build & development commands

- `npm run typecheck` — TypeScript type check, no emit.
- `npm run build` — tsc compile to `out/`. What the "Run Extension"
  launch config uses for in-editor dev.
- `npm run bundle` — esbuild bundle to `out/extension.js`. Used by
  packaging; not needed for normal dev.
- `npm run package` — `vsce package` → `out/vscode-mojo.vsix`.
- `npm test` — runs both `default` and `pixi` test labels.
- `npx eslint extension` — lint just the source tree (scopes around
  the `.vscode-test/` directory which can OOM eslint).

## Architecture summary

- **Entry point:** `extension/extension.ts:MojoExtension`. Activates on
  startup, wires up `PythonEnvironmentManager`, `SDKStatusBar`, and
  `MojoLSPManager`.
- **LSP:** `extension/lsp/lsp.ts` invokes `mojo-lsp-server` directly
  via stdio using `vscode-languageclient`'s `Executable` server options.
  There is no intermediary node process.
- **SDK detection** (`extension/pyenv.ts:PythonEnvironmentManager`):
  priority order is `mojo.sdk.path` override → monorepo `.derived/` →
  workspace-local env (`.pixi/envs/*/share/max/modular.cfg` or
  `.venv/bin/mojo`) → Python extension's active interpreter. The
  workspace-env step is gated on `mojo.preferWorkspaceEnv` (default
  `true`; the deprecated `mojo.preferPixiEnv` is honored as a fallback
  alias). Active SDK is cached; `refresh()` invalidates and re-runs
  detection.
- **Status bar** (`extension/statusBar.ts:SDKStatusBar`): two items —
  SDK state and LSP state. Visibility tied to a `.mojo` file being
  open or present in the workspace; uses one shared `checkVisibility()`.
- **Commands:** LSP commands in `extension/lsp/lsp.ts`, debug in
  `extension/debug/`, run/file commands in `extension/commands/run.ts`.

## Tests

Three labels declared in `.vscode-test.mjs`:

- **`default`** — `*.test.default.ts` against the repo root.
- **`pixi`** — `*.test.pixi.ts` against `fixtures/pixi-workspace/`,
  which expects an installed pixi env. CI prepares this via
  `pixi install --locked` before running tests.
- **`uv`** — `*.test.uv.ts` against `fixtures/uv-workspace/`, which
  expects a wheel install in `.venv/`. CI prepares this via
  `uv sync --frozen` before running tests.

Each test launches a fresh VS Code instance via `@vscode/test-cli`.
`mojo.extension.restart` is the standard way to reset extension state
between assertions within a single test.

Test files may live in subdirectories of `extension/` alongside the
code they test (e.g., `extension/lsp/lsp.test.pixi.ts`); the CI globs
`out/**/*.test.<label>.js` pick them up automatically.

When a test is fixture-agnostic (uses `workspaceFolders[0]` rather
than a hardcoded path), extract its body into a `*TestBody.ts` file
and have the `.test.pixi.ts` / `.test.uv.ts` wrappers be one-line
side-effect imports (`import './xTestBody';`). Mocha registers the
tests when loading the wrapper. See `extension/lsp/lspTestBody.ts`
for an example. Keep tests separate if they legitimately need to
differ per label (as `pyenv.test.pixi.ts` and `pyenv.test.uv.ts` do).

**CI shape:** a single `default-tests` job runs the OS-independent
`default` label on `ubuntu-latest`. `env-tests` is a matrix over
`(os × env)` with `os: [ubuntu-latest, macos-latest]` and
`env: [pixi, uv]`, giving four cells. Each cell only sets up the env
it needs (via `if: matrix.env == '...'` guards) and runs only its
matching label via `--label ${{ matrix.env }}`. `xvfb-run` is
Linux-only, so the "Execute tests" step splits per-OS on `runner.os`.

**Fixture lockfiles pin the installed SDK.** Both fixtures pin an
exact SDK version through their lockfile (`pixi.lock` and `uv.lock`);
refresh periodically so CI exercises the current SDK layout instead
of a snapshot from many months ago — `pixi update` inside
`fixtures/pixi-workspace/`, or `uv lock --upgrade` inside
`fixtures/uv-workspace/`.

## Conventions

- **Pin GitHub Actions to commit SHAs**, not tag references. Existing
  workflows already do this; new ones should match.
- **Minimal default permissions** on workflows: `permissions: contents: read`
  at workflow level, with per-job overrides where strictly needed.
- **Dev loop:** open repo in VS Code → press F5 → "Run Extension"
  launches an extension-development-host window with the local build.

## File layout

```
extension/                  # All TypeScript source
├── extension.ts            # Activation entry point
├── pyenv.ts                # SDK detection
├── statusBar.ts            # Status bar items
├── lsp/                    # Language client setup
├── debug/                  # Debugger integration
├── commands/               # User commands
├── external/               # Vendored 3rd-party (e.g., ps-list)
├── utils/                  # Shared helpers
└── *.test.{default,pixi,uv}.ts  # Tests by label (with *TestBody.ts helpers)

fixtures/pixi-workspace/    # Pixi test fixture (mojo project)
fixtures/uv-workspace/      # uv test fixture (wheel install)
.github/workflows/          # CI: test, lint, build, deploy, etc.
```
