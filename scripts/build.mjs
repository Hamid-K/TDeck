import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await mkdir('dist/icons', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/background.ts'], outfile: 'dist/background.js', bundle: true, format: 'esm', target: 'chrome120', minify: false, sourcemap: false }),
  build({ entryPoints: ['src/source/content.ts'], outfile: 'dist/content.js', bundle: true, format: 'iife', target: 'chrome120', minify: false }),
  build({ entryPoints: ['src/ui/main.tsx'], outfile: 'dist/app.js', bundle: true, format: 'esm', target: 'chrome120', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file' } }),
]);
await copyFile('manifest.json', 'dist/manifest.json');
await writeFile('dist/index.html', '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>TDeck · Your X, in focus</title><link rel="icon" href="icons/32.png"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>\n');

// Generate our code-native three-column app mark as RGBA PNG at each required size.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}
function icon(size) {
  const stride = size * 4 + 1, data = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * stride + 1 + x * 4, px = x / size, py = y / size;
    const rounded = Math.hypot(Math.max(0, Math.abs(px - .5) - .30), Math.max(0, Math.abs(py - .5) - .30)) < .18;
    const bar = (px > .22 && px < .36 && py > .24 && py < .78) || (px > .43 && px < .57 && py > .24 && py < .61) || (px > .64 && px < .78 && py > .24 && py < .72);
    data[i] = bar ? 135 : 20; data[i + 1] = bar ? 229 : 27; data[i + 2] = bar ? 199 : 31; data[i + 3] = rounded ? 255 : 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]);
}
await Promise.all([16, 32, 48, 128].map(size => writeFile(`dist/icons/${size}.png`, icon(size))));
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
for (const file of ['index.html', 'app.js', 'app.css', manifest.background.service_worker, ...manifest.content_scripts.flatMap(s => s.js)]) await readFile(`dist/${file}`);
console.log('TDeck built and package entries verified: dist/');
