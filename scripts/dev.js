// One command for local development: starts the API (port 3000) and the web app (port 5173) together.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, '.env'))) {
  console.error('\nMissing .env file. Copy .env.example to .env and fill in DATABASE_URL, JWT_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD.\n');
  process.exit(1);
}
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const procs = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [vite], { cwd: root, stdio: 'inherit' })
];
const stop = () => procs.forEach(p => { try { p.kill(); } catch (e) { /* already stopped */ } });
procs.forEach(p => p.on('exit', code => { if (code) { stop(); process.exit(code); } }));
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
console.log('\nOpen http://localhost:5173 once you see "listening on 3000" below.\n');
