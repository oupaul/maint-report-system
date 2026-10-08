const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const db = require('../models/db');
const BackupService = require('./BackupService');
const MailService = require('./MailService');
const pkg = require('../../package.json');

// 檢查結果的等級：ok 正常、warn 需要留意、bad 需要處理
const RANK = { ok: 0, warn: 1, bad: 2 };

let uploadsSizeCache = { at: 0, bytes: 0 };
const UPLOADS_CACHE_MS = 5 * 60 * 1000;

async function uploadsSize() {
  if (Date.now() - uploadsSizeCache.at < UPLOADS_CACHE_MS) return uploadsSizeCache.bytes;
  const bytes = await BackupService.dirSize(config.UPLOADS_DIR);
  uploadsSizeCache = { at: Date.now(), bytes };
  return bytes;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

function diskInfo(dir) {
  // 目錄還不存在（例如備份目錄尚未建立）就往上找到存在的那一層，量的是同一顆磁碟
  let target = dir;
  while (!fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  try {
    const st = fs.statfsSync(target);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, freePct: total ? (free / total) * 100 : 0 };
  } catch (e) {
    return null;
  }
}

function diskCheck(label, info) {
  if (!info) return { key: label, label, status: 'warn', detail: '無法讀取磁碟資訊' };
  const status = info.freePct < 5 ? 'bad' : info.freePct < 15 ? 'warn' : 'ok';
  return { key: label, label, status, detail: `剩餘 ${info.freePct.toFixed(1)}%` };
}

// 「還能用的記憶體」：Linux 讀 MemAvailable（含可回收的快取，這才是真正判斷記憶體吃緊的依據；
// 單看 MemFree 會因為檔案快取佔滿而永遠偏低、造成誤報）。其他系統（例如 macOS 開發機）的
// os.freemem() 不含可回收頁面，數字沒有參考價值，所以只顯示、不拿來判定狀態。
function availableMemory() {
  if (process.platform === 'linux') {
    try {
      const m = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (m) return { bytes: parseInt(m[1], 10) * 1024, reliable: true };
    } catch (e) { /* 讀不到就當作無法判定 */ }
  }
  return { bytes: os.freemem(), reliable: false };
}

function countRows(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  } catch (e) {
    return null;
  }
}

async function collect() {
  const checks = [];
  const now = Date.now();

  // 資料庫：實際查一次，量回應時間
  let dbOk = true;
  let dbMs = null;
  try {
    const t0 = process.hrtime.bigint();
    db.prepare('SELECT 1').get();
    dbMs = Number(process.hrtime.bigint() - t0) / 1e6;
  } catch (e) {
    dbOk = false;
  }
  checks.push({
    key: 'db', label: '資料庫',
    status: dbOk ? (dbMs > 500 ? 'warn' : 'ok') : 'bad',
    detail: dbOk ? `可正常讀取（${dbMs.toFixed(1)} ms）` : '無法讀取資料庫',
  });

  const dataDisk = diskInfo(config.DATA_DIR);
  checks.push(diskCheck('資料磁碟空間', dataDisk));
  const backupDisk = diskInfo(config.BACKUP_DIR);
  checks.push(diskCheck('備份磁碟空間', backupDisk));

  // 備份：停用、最近一次失敗、太久沒有新備份都要提醒——沒人看的備份壞了才是最危險的
  const settings = BackupService.getSettings();
  const backups = await BackupService.list();
  const newest = backups[0] || null;
  let backupStatus = 'ok';
  let backupDetail;
  if (!settings.enabled) {
    backupStatus = 'warn';
    backupDetail = '自動備份已停用';
  } else if (settings.last_status === 'failed') {
    backupStatus = 'bad';
    backupDetail = `最近一次備份失敗：${settings.last_message || '未知原因'}`;
  } else if (!newest) {
    backupStatus = 'warn';
    backupDetail = '尚未產生任何備份';
  } else {
    const maxAgeMs = (settings.frequency === 'weekly' ? 8 * 24 : 36) * 60 * 60 * 1000;
    const ageH = (now - newest.mtimeMs) / 3600000;
    if (now - newest.mtimeMs > maxAgeMs) {
      backupStatus = 'warn';
      backupDetail = `最新備份已是 ${ageH.toFixed(0)} 小時前，超過預期的備份間隔`;
    } else {
      backupDetail = `最新備份在 ${ageH < 1 ? '1 小時內' : `${ageH.toFixed(0)} 小時前`}`;
    }
  }
  checks.push({ key: 'backup', label: '備份', status: backupStatus, detail: backupDetail });

  // Email 通知：沒啟用就不評估；啟用後近 24 小時有寄送失敗就提醒（常見原因：密碼過期、Client Secret 到期）
  const mail = MailService.settingsForView();
  if (!mail.enabled) {
    checks.push({ key: 'mail', label: 'Email 通知', status: 'ok', detail: '未啟用（只有站內通知）' });
  } else {
    const failed = MailService.recentFailures(24);
    checks.push({
      key: 'mail', label: 'Email 通知',
      status: failed > 0 ? 'warn' : 'ok',
      detail: failed > 0 ? `近 24 小時有 ${failed} 封通知信寄送失敗，請到「Email 通知」頁查看原因` : '已啟用，近 24 小時沒有寄送失敗',
    });
  }

  const totalMem = os.totalmem();
  const mem = availableMemory();
  const freeMem = mem.bytes;
  const memFreePct = (freeMem / totalMem) * 100;
  checks.push({
    key: 'memory', label: '系統記憶體',
    status: !mem.reliable ? 'ok' : memFreePct < 5 ? 'bad' : memFreePct < 10 ? 'warn' : 'ok',
    detail: mem.reliable ? `可用 ${memFreePct.toFixed(0)}%` : `可用約 ${memFreePct.toFixed(0)}%（此系統無法準確判定，僅供參考）`,
  });

  const overall = checks.reduce((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), 'ok');

  const dbFile = config.DB_PATH;
  return {
    overall,
    checks,
    checkedAt: now,
    app: {
      version: pkg.version,
      node: process.version,
      env: config.NODE_ENV,
      port: config.PORT,
      uptimeSec: process.uptime(),
      rssBytes: process.memoryUsage().rss,
      pid: process.pid,
      trustProxy: config.TRUST_PROXY === false ? '未啟用' : String(config.TRUST_PROXY),
      m365: config.M365_ENABLED,
    },
    system: {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSec: os.uptime(),
      load: os.loadavg(),
      cpus: os.cpus().length,
      totalMem,
      freeMem,
    },
    storage: {
      dbBytes: fileSize(dbFile),
      walBytes: fileSize(`${dbFile}-wal`),
      uploadsBytes: await uploadsSize(),
      backupCount: backups.length,
      backupBytes: backups.reduce((sum, b) => sum + b.size, 0),
      dataDisk,
      backupDisk,
    },
    counts: {
      users: countRows('users'),
      assets: countRows('assets'),
      batches: countRows('inspection_batches'),
      items: countRows('inspection_items'),
      photos: countRows('inspection_item_photos'),
    },
    backup: settings,
  };
}

// 資料庫完整性檢查：資料庫很大時會花一點時間，所以只在管理員按按鈕時才跑，不放在自動重新整理的畫面裡
function quickCheck() {
  const t0 = Date.now();
  const result = db.pragma('quick_check', { simple: true });
  return { ok: result === 'ok', result: String(result), ms: Date.now() - t0 };
}

// 給外部監控（Uptime Kuma、Cloudflare Health Check…）用的最小回應：只回「活著且資料庫可用」，不洩漏任何細節
function liveness() {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { collect, quickCheck, liveness };
