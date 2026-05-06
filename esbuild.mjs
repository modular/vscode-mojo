import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['extension/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  external: ['vscode'],
});
