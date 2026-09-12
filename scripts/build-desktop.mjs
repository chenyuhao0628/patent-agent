import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfWorker = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
await build({
  entryPoints: ['desktop/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron', '@napi-rs/canvas'],
  outfile: 'desktop-dist/main.cjs',
});
await build({
  entryPoints: ['desktop/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  outfile: 'desktop-dist/preload.cjs',
});
copyFileSync(pdfWorker, 'desktop-dist/pdf.worker.mjs');
await build({entryPoints:['desktop/document-visual-worker.ts'],alias:{'@hyzyla/pdfium':require.resolve('@hyzyla/pdfium')},bundle:true,platform:'node',format:'cjs',target:'node24',outfile:'desktop-dist/document-visual-worker.cjs'});
copyFileSync(require.resolve('@hyzyla/pdfium/pdfium.wasm'),'desktop-dist/pdfium.wasm');
