// What the build produces. Paths in `entry` and `from` are relative to the build root (the
// repository, or the directory named by --root); `outfile` and `to` are relative to the
// output directory (<root>/plugins by default).
export const bundles = [
  {
    name: 'renderer',
    entry: 'src/hoard/renderer.ts',
    outfile: 'hoard/renderer.js',
    // A classic script: the CSP allows `script-src 'self'` and the window loads no modules.
    options: { format: 'iife', platform: 'browser', target: 'es2024' },
  },
  {
    name: 'main',
    entry: 'src/hoard/main.ts',
    outfile: 'hoard/main.cjs',
    // Electron supplies itself at run time; bundling it would shadow the real module.
    options: { format: 'cjs', platform: 'node', target: 'es2024', external: ['electron'] },
  },
  {
    name: 'textconv',
    entry: 'tools/git/neo-textconv.js',
    outfile: 'hoard/textconv.cjs',
    // git runs it for blame, through Electron as node; package.json unpacks it from the asar.
    options: { format: 'cjs', platform: 'node', target: 'es2024' },
  },
];

export const copies = [
  { name: 'manifest', from: 'src/hoard/plugin.json', to: 'hoard/plugin.json' },
];
