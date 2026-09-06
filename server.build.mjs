import { build } from 'esbuild';
await build({ entryPoints: ['src/server/main.ts', 'src/server/migrate.ts'], bundle: true,
  outdir: 'dist/server', platform: 'node', format: 'cjs', outExtension: { '.js': '.cjs' }, target: 'node24',
  packages: 'bundle', external: ['node:*'], logLevel: 'info' });
