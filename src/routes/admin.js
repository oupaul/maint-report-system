const fs = require('fs');
const express = require('express');
const router = express.Router();

const config = require('../config');
const { requireRole } = require('../middleware/auth');
const User = require('../models/User');
const BackupService = require('../services/BackupService');
const HealthService = require('../services/HealthService');
const ActivityTracker = require('../services/ActivityTracker');
const fmt = require('../utils/format');

// 系統狀態、備份管理只有管理員能看：備份檔裡有完整資料庫（含密碼雜湊）與所有截圖
router.use(requireRole('admin'));
router.use((req, res, next) => {
  res.locals.fmt = fmt;
  next();
});

// 網址只帶固定代碼、不帶任何文字，避免有人做出一個網址讓管理員頁面顯示任意內容
const FLASH = {
  ok: {
    saved: '備份設定已儲存',
    started: '已開始備份，完成後這個頁面會自動更新結果',
    deleted: '備份檔已刪除',
  },
  err: {
    busy: '已經有一個備份正在進行中，請等它完成',
    notfound: '找不到指定的備份檔',
  },
};

// ---- 系統狀態 ----

async function renderStatus(req, res, extra = {}) {
  const health = await HealthService.collect();
  const online = ActivityTracker.listOnline();
  const recentLogins = User.findAll()
    .filter((u) => u.last_login_at)
    .sort((a, b) => (a.last_login_at < b.last_login_at ? 1 : -1))
    .slice(0, 10);
  res.render('admin/status', {
    health,
    online,
    onlineUsers: new Set(online.map((e) => e.userId)).size,
    recentLogins,
    refreshSeconds: 30,
    dbCheck: null,
    ...extra,
  });
}

router.get('/status', async (req, res, next) => {
  try {
    await renderStatus(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/status/db-check', async (req, res, next) => {
  try {
    await renderStatus(req, res, { dbCheck: HealthService.quickCheck(), refreshSeconds: undefined });
  } catch (err) {
    next(err);
  }
});

// ---- 備份管理 ----

async function renderBackups(req, res, { error = null, form = null, status = 200 } = {}) {
  const settings = BackupService.getSettings();
  const backups = await BackupService.list();
  const running = BackupService.isRunning();
  let freeBytes = null;
  try {
    freeBytes = BackupService.freeBytes(fs.existsSync(config.BACKUP_DIR) ? config.BACKUP_DIR : config.PROJECT_ROOT);
  } catch (e) { /* 讀不到就不顯示 */ }

  res.status(status).render('admin/backups', {
    settings: form ? { ...settings, ...form } : settings,
    backups,
    running,
    freeBytes,
    backupDir: config.BACKUP_DIR,
    nextSlotLabel: describeSchedule(settings),
    refreshSeconds: running ? 5 : undefined,
    ok: FLASH.ok[req.query.ok] || null,
    error: error || FLASH.err[req.query.err] || null,
  });
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
function describeSchedule(s) {
  if (!s.enabled) return '自動備份已停用';
  return s.frequency === 'weekly'
    ? `每週${WEEKDAYS[s.weekday]} ${s.run_time}（台北時間）`
    : `每天 ${s.run_time}（台北時間）`;
}

router.get('/backups', async (req, res, next) => {
  try {
    await renderBackups(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/backups/settings', async (req, res, next) => {
  try {
    const parsed = BackupService.validateSettings(req.body);
    if (parsed.error) {
      return await renderBackups(req, res, { error: parsed.error, form: req.body, status: 400 });
    }
    BackupService.updateSettings(parsed.value);
    console.log(`[備份] ${req.user.username} 更新備份排程：${describeSchedule({ ...parsed.value })}，保留 ${parsed.value.retention_days} 天`);
    res.redirect('/admin/backups?ok=saved');
  } catch (err) {
    next(err);
  }
});

router.post('/backups/run', (req, res) => {
  if (BackupService.isRunning()) return res.redirect('/admin/backups?err=busy');
  console.log(`[備份] ${req.user.username} 手動觸發備份`);
  // 備份可能要跑一陣子（打包截圖），不讓這個請求等著；結果會寫進資料庫，頁面會顯示並自動更新
  BackupService.createBackup({ trigger: 'manual' }).catch((err) => console.error('[備份] 手動備份失敗：', err));
  res.redirect('/admin/backups?ok=started');
});

router.get('/backups/:name/download', (req, res) => {
  const full = BackupService.safeBackupPath(req.params.name);
  if (!full || !fs.existsSync(full)) {
    return res.status(404).render('error', { title: '找不到備份檔', message: '找不到指定的備份檔' });
  }
  console.log(`[備份] ${req.user.username} 下載備份檔 ${req.params.name}`);
  res.setHeader('Cache-Control', 'no-store');
  res.download(full, req.params.name);
});

router.post('/backups/:name/delete', async (req, res, next) => {
  try {
    const removed = await BackupService.remove(req.params.name);
    if (removed) console.log(`[備份] ${req.user.username} 刪除備份檔 ${req.params.name}`);
    res.redirect(removed ? '/admin/backups?ok=deleted' : '/admin/backups?err=notfound');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
