const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const Database = require('better-sqlite3');

const config = require('../config');
const db = require('../models/db');
const { nowTaipei, taipeiParts } = require('../utils/time');

const execFileAsync = promisify(execFile);

// 備份檔格式與 backup.sh / restore.sh 完全相同（backup_YYYYMMDD_HHMMSS.tar.gz，裡面是同名資料夾，
// 含 data/maint_report.db、uploads/、backup_info.txt、package.json），所以網頁產生的備份可以直接用
// restore.sh 還原，反過來 backup.sh 產生的舊備份也會出現在網頁的清單裡。
// 還原動作刻意不開放在網頁上：它會覆蓋正在使用中的資料庫，一律在主機上用 restore.sh 做。
const FILENAME_RE = /^backup_\d{8}_\d{6}\.tar\.gz$/;
const TAR_TIMEOUT_MS = 15 * 60 * 1000;
const TICK_MS = 30 * 1000;

let running = null; // { startedAt, trigger }
let timer = null;

function getSettings() {
  return db.prepare('SELECT * FROM backup_settings WHERE id = 1').get();
}

function validateSettings(body) {
  const frequency = body.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly') return { error: '請選擇備份頻率' };
  const runTime = typeof body.run_time === 'string' ? body.run_time : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(runTime)) return { error: '備份時間格式不正確（請填 24 小時制，例如 02:00）' };
  const weekday = parseInt(body.weekday, 10);
  if (!(weekday >= 0 && weekday <= 6)) return { error: '請選擇星期' };
  const retention = parseInt(body.retention_days, 10);
  if (!(retention >= 1 && retention <= 365)) return { error: '保留天數需介於 1 到 365 天' };
  return {
    value: {
      enabled: body.enabled === 'on' || body.enabled === '1' ? 1 : 0,
      frequency,
      run_time: runTime,
      weekday,
      retention_days: retention,
    },
  };
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

// 「依目前設定，到現在為止最近一次應該執行的時間點」（台北時間，字串可直接比大小）。
// 排程不是等到剛好那一分鐘才動手，而是「最近一個應該跑的時間點之後還沒跑過就補跑」，
// 所以服務剛好在備份時間重啟、或主機當時關機，開機後仍會補上這次備份。
function latestSlot(settings, nowMs = Date.now()) {
  const now = taipeiParts(nowMs);
  if (settings.frequency === 'weekly') {
    for (let i = 0; i <= 7; i++) {
      const weekday = (now.weekday - i + 7) % 7;
      if (weekday === settings.weekday && (i > 0 || now.time >= settings.run_time)) {
        return `${shiftDate(now.date, -i)} ${settings.run_time}`;
      }
    }
  }
  const date = now.time >= settings.run_time ? now.date : shiftDate(now.date, -1);
  return `${date} ${settings.run_time}`;
}

function updateSettings(value, nowMs = Date.now()) {
  // 把 last_slot 設成「依新設定到現在為止最近的時間點」：改設定只影響之後的備份，
  // 不會因為把時間調到比現在早，就立刻補跑一次。
  const slot = latestSlot(value, nowMs);
  db.prepare(
    `UPDATE backup_settings SET enabled = ?, frequency = ?, run_time = ?, weekday = ?, retention_days = ?, last_slot = ?
     WHERE id = 1`
  ).run(value.enabled, value.frequency, value.run_time, value.weekday, value.retention_days, slot);
}

function ensureBackupDir() {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function safeBackupPath(name) {
  if (typeof name !== 'string' || !FILENAME_RE.test(name)) return null;
  return path.join(config.BACKUP_DIR, name);
}

async function list() {
  let names;
  try {
    names = await fsp.readdir(config.BACKUP_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!FILENAME_RE.test(name)) continue;
    try {
      const st = await fsp.stat(path.join(config.BACKUP_DIR, name));
      if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch (e) { /* 剛好被刪掉就略過 */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) {
      try { total += (await fsp.stat(full)).size; } catch (e) { /* ignore */ }
    }
  }
  return total;
}

function freeBytes(dir) {
  const st = fs.statfsSync(dir);
  return st.bavail * st.bsize;
}

async function prune(retentionDays) {
  const files = await list();
  if (files.length <= 1) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const deleted = [];
  // 最新的一份不管多舊都保留，避免保留天數設得太短、或排程停擺時，把最後一份備份也清光
  for (const f of files.slice(1)) {
    if (f.mtimeMs < cutoff) {
      try {
        await fsp.unlink(path.join(config.BACKUP_DIR, f.name));
        deleted.push(f.name);
      } catch (e) { /* ignore */ }
    }
  }
  return deleted;
}

function recordResult({ ok, trigger, file, message }) {
  db.prepare(
    `UPDATE backup_settings SET last_run_at = ?, last_status = ?, last_message = ?, last_file = ?, last_trigger = ? WHERE id = 1`
  ).run(nowTaipei(), ok ? 'success' : 'failed', String(message).slice(0, 2000), file || null, trigger);
}

function isRunning() {
  return running ? { ...running } : null;
}

async function createBackup({ trigger = 'manual' } = {}) {
  if (running) throw new Error('已經有一個備份正在進行中');
  running = { startedAt: Date.now(), trigger };
  db.prepare("UPDATE backup_settings SET last_status = 'running', last_trigger = ? WHERE id = 1").run(trigger);

  const parts = taipeiParts();
  const name = `backup_${parts.stamp}`;
  const finalPath = path.join(config.BACKUP_DIR, `${name}.tar.gz`);
  const partPath = path.join(config.BACKUP_DIR, `.${name}.tar.gz.part`);
  const stageRoot = path.join(config.BACKUP_DIR, `.staging-${name}`);
  const stageDir = path.join(stageRoot, name);

  try {
    ensureBackupDir();
    if (fs.existsSync(finalPath)) throw new Error('同一秒內已經產生過備份，請稍後再試');

    // 先確認磁碟空間夠（以未壓縮大小保守估計），不夠就不要開始，避免寫到一半把磁碟塞滿、
    // 連帶讓服務本身（資料庫、截圖）寫不進去。
    const dbSize = fs.existsSync(config.DB_PATH) ? fs.statSync(config.DB_PATH).size : 0;
    const need = dbSize + (await dirSize(config.UPLOADS_DIR));
    const free = freeBytes(config.BACKUP_DIR);
    if (free < need * 1.1 + 50 * 1024 * 1024) {
      throw new Error(`備份目錄所在磁碟空間不足（可用 ${(free / 1048576).toFixed(0)} MB，預估需要 ${(need / 1048576).toFixed(0)} MB 以上）`);
    }

    fs.mkdirSync(path.join(stageDir, 'data'), { recursive: true, mode: 0o700 });

    // 用 SQLite 內建的線上備份 API 取得資料庫快照：服務還在寫入（含 WAL 裡尚未合併的內容）時
    // 也能得到一致的副本，不像直接 cp 資料庫檔案可能抓到寫到一半的狀態。
    const snapshot = path.join(stageDir, 'data', 'maint_report.db');
    await db.backup(snapshot);

    // 驗證快照本身：能開、完整性檢查通過、使用者表讀得到——備份檔壞掉卻不知道，等於沒備份
    const snap = new Database(snapshot, { readonly: true });
    let userCount;
    try {
      const check = snap.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`資料庫快照完整性檢查失敗：${check}`);
      userCount = snap.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    } finally {
      snap.close();
    }

    if (fs.existsSync(config.UPLOADS_DIR)) {
      fs.symlinkSync(config.UPLOADS_DIR, path.join(stageDir, 'uploads'));
    }
    for (const f of ['package.json', 'package-lock.json']) {
      const src = path.join(config.PROJECT_ROOT, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stageDir, f));
    }
    fs.writeFileSync(
      path.join(stageDir, 'backup_info.txt'),
      [
        `備份時間: ${nowTaipei()}（台北時間）`,
        `備份名稱: ${name}`,
        `產生方式: ${trigger === 'schedule' ? '網頁排程自動備份' : '網頁手動備份'}`,
        `備份內容: 資料庫 data/maint_report.db（SQLite 線上備份快照，使用者 ${userCount} 筆）、上傳檔案 uploads/、package.json`,
        '還原方式: 在主機上執行 restore.sh',
        '',
      ].join('\n')
    );

    // -h：把 uploads 的符號連結展開成實際內容放進壓縮檔（避免為了備份把整個 uploads 複製一份）
    await execFileAsync('tar', ['-czhf', partPath, '-C', stageRoot, name], { timeout: TAR_TIMEOUT_MS });
    fs.chmodSync(partPath, 0o600);

    const { stdout } = await execFileAsync('tar', ['-tzf', partPath], { timeout: TAR_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    if (!stdout.split('\n').some((line) => line.replace(/^\.\//, '') === `${name}/data/maint_report.db`)) {
      throw new Error('壓縮檔驗證失敗：找不到資料庫檔案');
    }
    fs.renameSync(partPath, finalPath);

    const size = fs.statSync(finalPath).size;
    const retention = getSettings().retention_days;
    const pruned = await prune(retention);
    const message = `備份完成（${(size / 1048576).toFixed(1)} MB）${pruned.length ? `，已依保留 ${retention} 天清除 ${pruned.length} 份舊備份` : ''}`;
    recordResult({ ok: true, trigger, file: `${name}.tar.gz`, message });
    console.log(`[備份] ${message}：${name}.tar.gz（${trigger}）`);
    return { ok: true, file: `${name}.tar.gz`, size, message };
  } catch (err) {
    const message = err.message || String(err);
    recordResult({ ok: false, trigger, file: null, message });
    console.error(`[備份] 失敗（${trigger}）：${message}`);
    return { ok: false, message };
  } finally {
    // 暫存資料夾與半成品一律在這裡清乾淨（等清完才結束），不留下 .staging-* / .part 殘留
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(partPath, { force: true }).catch(() => {});
    running = null;
  }
}

async function remove(name) {
  const full = safeBackupPath(name);
  if (!full) return false;
  try {
    await fsp.unlink(full);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function tick(nowMs = Date.now()) {
  if (running) return;
  const settings = getSettings();
  if (!settings || !settings.enabled) return;
  const slot = latestSlot(settings, nowMs);
  if (settings.last_slot && settings.last_slot >= slot) return;
  // 先記下這個時間點再開始備份：就算這次備份失敗，也不會每 30 秒重試一次把主機打爆，
  // 失敗結果會顯示在「備份管理」與「系統狀態」，下一個排程時間點再試。
  db.prepare('UPDATE backup_settings SET last_slot = ? WHERE id = 1').run(slot);
  await createBackup({ trigger: 'schedule' });
}

function startScheduler() {
  // 服務如果在備份進行中被重啟，資料庫裡會留著 running 狀態，開機時把它標成中斷
  db.prepare(
    "UPDATE backup_settings SET last_status = 'failed', last_message = '備份進行中服務被重新啟動，這次備份中斷' WHERE id = 1 AND last_status = 'running'"
  ).run();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick().catch((err) => console.error('[備份] 排程檢查失敗：', err));
  }, TICK_MS);
  timer.unref();
  setTimeout(() => tick().catch((err) => console.error('[備份] 排程檢查失敗：', err)), 15 * 1000).unref();
}

module.exports = {
  FILENAME_RE,
  getSettings,
  validateSettings,
  updateSettings,
  latestSlot,
  list,
  createBackup,
  remove,
  safeBackupPath,
  prune,
  isRunning,
  startScheduler,
  tick,
  freeBytes,
  dirSize,
};
