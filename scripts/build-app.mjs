// Copies the web app into www/ for the Android app (Capacitor) and tells it where the server is.
//   MG_API_URL=https://api.example.com npm run sync
// Without MG_API_URL it uses http://10.0.2.2:8000, which is how the Android emulator reaches this Mac.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const api = (process.env.MG_API_URL || 'http://10.0.2.2:8000').replace(/\/+$/, '');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const p of ['i18n/app-strings.js', 'i18n/app', 'assets', 'manifest.webmanifest']) cpSync(join(root, p), join(out, p), { recursive: true });

// app.html becomes the start page; MG_API has to be set before the account script runs
const html = readFileSync(join(root, 'app.html'), 'utf8');
const marker = '<script>\n// Theme before first paint';
if (!html.includes(marker)) throw new Error('app.html changed: cannot find where to put MG_API');
writeFileSync(join(out, 'index.html'), html.replace(marker, `<script>window.MG_API = ${JSON.stringify(api)};</script>\n${marker}`));
console.log(`www/ ready, server: ${api}`);
