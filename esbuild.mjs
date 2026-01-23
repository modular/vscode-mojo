import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['extension/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  external: ['vscode'],
});

await esbuild.build({
  entryPoints: ['lsp-proxy/src/proxy.ts'],
  bundle: true,
  outfile: 'out/proxy.js',
  platform: 'node',
  external: ['vscode', 'fsevents'],
});
