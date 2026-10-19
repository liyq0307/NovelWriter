/**
 * 开发启动器：同时运行 服务端(3000) 与 前端 Vite(5173)，Ctrl+C 一并退出。
 * 直接以当前 Node 可执行文件拉起两者，不经 npm.cmd（Windows 下 spawn .cmd 会 EINVAL）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const procs = [];

function start(name, args, cwd) {
  const p = spawn(process.execPath, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = (chunk) => String(chunk).split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n';
  p.stdout.on('data', (d) => process.stdout.write(tag(d)));
  p.stderr.on('data', (d) => process.stderr.write(tag(d)));
  p.on('exit', (code) => {
    process.stdout.write(`[${name}] 已退出（code=${code}）\n`);
    killAll();
  });
  procs.push(p);
}

function killAll() {
  for (const p of procs) {
    if (p.exitCode === null && !p.killed) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
        else p.kill('SIGTERM');
      } catch { /* 忽略 */ }
    }
  }
}

// 服务端：node --watch src/index.js
start('server', ['--watch', 'src/index.js'], path.join(ROOT, 'server'));

// 前端：node client/node_modules/vite/bin/vite.js
const viteBin = path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error('[client] 未找到 vite，请先执行：npm --prefix client install');
  process.exit(1);
}
start('client', [viteBin], path.join(ROOT, 'client'));

process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });
