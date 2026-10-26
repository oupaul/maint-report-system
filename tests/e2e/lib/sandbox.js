// 測試用的「沙盒」：把專案複製到暫存目錄，用全新的資料庫與獨立的埠啟動，測完整個刪掉。
// 完全不碰專案裡的 data/、uploads/、backups/（你的真實資料）。node_modules 用連結共用，不重裝。
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PASSWORD = 'Demo-Pass-2026x'; // 所有測試帳號（含 admin）共用，符合密碼強度規則
const EXCLUDE_TOP = new Set(['node_modules', 'data', 'uploads', 'backups', '.git', 'tests', 'docs', 'coverage']);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Sandbox {
  constructor({ keep = false } = {}) {
    this.keep = keep;
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-e2e-'));
    this.dbPath = path.join(this.root, 'data', 'maint_report.db');
    this.pristine = path.join(this.root, 'pristine.db');
    this.proc = null;
    this.port = null;
    this.logPath = path.join(this.root, 'server.log');
  }

  get base() { return `http://127.0.0.1:${this.port}`; }

  // 複製專案（排除真實資料與測試本身）、連結 node_modules、建立資料庫與基本帳號，存成「乾淨快照」
  async prepare() {
    fs.cpSync(REPO, this.root, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(REPO, src);
        if (!rel) return true;
        const top = rel.split(path.sep)[0];
        return !EXCLUDE_TOP.has(top) && !rel.endsWith('.log') && !rel.endsWith('.db');
      },
    });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(this.root, 'node_modules'), 'dir');
    fs.mkdirSync(path.join(this.root, 'data'), { recursive: true });
    execFileSync(process.execPath, ['migrations/runner.js'], {
      cwd: this.root,
      env: { ...process.env, INITIAL_ADMIN_PASSWORD: PASSWORD, SESSION_SECRET: 'e2e' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const Database = require('better-sqlite3');
    const argon2 = require('argon2');
    const db = new Database(this.dbPath);
    const hash = await argon2.hash(PASSWORD);
    const now = '2026-01-01 09:00:00';
    db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();
    const ins = db.prepare("INSERT INTO users (username, password_hash, display_name, role, is_active, must_change_password, created_at) VALUES (?, ?, ?, 'technician', 1, 0, ?)");
    for (const [u, n] of [['wang', '王小明'], ['lin', '林雅婷'], ['outsider', '局外人']]) ins.run(u, hash, n, now);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    fs.copyFileSync(this.dbPath, this.pristine);
  }

  async start() {
    this.port = await freePort();
    const log = fs.openSync(this.logPath, 'a');
    this.proc = spawn(process.execPath, ['./src/app.js'], {
      cwd: this.root,
      env: { ...process.env, PORT: String(this.port), NODE_ENV: 'development', SESSION_SECRET: 'e2e-secret', PUPPETEER_SKIP_DOWNLOAD: '1' },
      stdio: ['ignore', log, log],
    });
    this.exited = false;
    this.proc.on('exit', () => { this.exited = true; });
    for (let i = 0; i < 100; i++) {
      if (this.exited) throw new Error(`伺服器啟動失敗，請看 ${this.logPath}`);
      try {
        const r = await fetch(`${this.base}/healthz`);
        if (r.ok) return;
      } catch (e) { /* 還沒好 */ }
      await sleep(200);
    }
    throw new Error(`伺服器 20 秒內沒有回應，請看 ${this.logPath}`);
  }

  async stop() {
    if (!this.proc || this.exited) return;
    this.proc.kill('SIGTERM');
    for (let i = 0; i < 50 && !this.exited; i++) await sleep(100);
    if (!this.exited) this.proc.kill('SIGKILL');
    await sleep(100);
  }

  // 每個測試檔都從同一份乾淨的資料庫與空的 uploads 重新開始（互不影響，也不需要各自清理）
  async reset() {
    await this.stop();
    for (const f of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) fs.rmSync(f, { force: true });
    fs.copyFileSync(this.pristine, this.dbPath);
    fs.rmSync(path.join(this.root, 'uploads'), { recursive: true, force: true });
    fs.rmSync(path.join(this.root, 'backups'), { recursive: true, force: true });
    await this.start();
  }

  async destroy() {
    await this.stop();
    if (this.keep) { console.log(`\n（--keep）沙盒保留在 ${this.root}`); return; }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

module.exports = { Sandbox, PASSWORD, REPO };
