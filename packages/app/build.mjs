import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: true, external: ['electron'], logLevel: 'info' };
await esbuild({ ...common, entryPoints: [path.join(here, 'src/main/main.ts')], outfile: path.join(here, 'dist/main.cjs') });
await esbuild({ ...common, entryPoints: [path.join(here, 'src/main/preload.ts')], outfile: path.join(here, 'dist/preload.cjs') });
await vite({
  root: path.join(here, 'src/renderer'), base: './', plugins: [react()], logLevel: 'warn',
  build: { outDir: path.join(here, 'dist/renderer'), emptyOutDir: true },
});
