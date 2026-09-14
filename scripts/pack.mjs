import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
await mkdir('release', { recursive: true });
const archive = `tdeck-${manifest.version}.zip`;
execFileSync('/usr/bin/zip', ['-r', `../release/${archive}`, '.', '-x', '*.DS_Store'], { cwd: 'dist', stdio: 'ignore' });
console.log(`Packaged release/${archive}`);
