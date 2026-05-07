import { defineConfig } from '@vscode/test-cli';

const baseConfig = {
  platform: 'desktop',
  version: '1.92.2',
  mocha: {
    timeout: 5 * 60 * 1000,
    reporter: 'out/test/reporter.js',
  },
};

export default defineConfig([
  {
    ...baseConfig,
    label: 'default',
    workspaceFolder: './',
    files: 'out/**/*.test.default.js',
  },
  {
    ...baseConfig,
    label: 'pixi',
    workspaceFolder: 'fixtures/pixi-workspace/',
    files: 'out/**/*.test.pixi.js',
    installExtensions: ['ms-python.python'],
  },
]);
