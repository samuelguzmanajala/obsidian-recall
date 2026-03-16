import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const aliasPlugin = {
  name: 'path-aliases',
  setup(build) {
    const aliases = {
      '@context': path.resolve(__dirname, 'src/context'),
      '@app': path.resolve(__dirname, 'src/app'),
      '@backend': path.resolve(__dirname, 'src/app/backend'),
      '@frontend': path.resolve(__dirname, 'src/app/frontend'),
    };

    build.onResolve({ filter: /^@(context|app|backend|frontend)\// }, (args) => {
      for (const [alias, target] of Object.entries(aliases)) {
        if (args.path.startsWith(alias + '/')) {
          const resolved = args.path.replace(alias, target) + '.ts';
          return { path: resolved };
        }
      }
    });
  },
};

const isWatch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'main.js',
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2022',
  platform: 'node',
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  plugins: [aliasPlugin],
  logLevel: 'info',
});

if (isWatch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
