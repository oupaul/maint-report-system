const fs = require('fs');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const config = require('../config');
const { requireRole, requirePermission } = require('../middleware/auth');
const User = require('../models/User');
const BackupService = require('../services/BackupService');
const HealthService = require('../services/HealthService');
const ActivityTracker = require('../services/ActivityTracker');
const LoginSession = require('../models/LoginSession');
const BrandingService = require('../services/BrandingService');
const fmt = require('../utils/format');

// 系統狀態、備份管理只有管理員能看：備份檔裡有完整資料庫（含密碼雜湊）與所有截圖
router.use((req, res, next) => {
  res.locals.fmt = fmt;
  next();
});

// 設備類型與檢查項目：管理員，或所屬權限群組有「管理設備類型」權限的人
router.use('/categories', requirePermission('categories.manage'), require('./adminCategories'));
// 客戶主檔：「管理資產建檔」權限（設備歸屬客戶是資產建檔的一部分）
router.use('/customers', requirePermission('assets.manage'), require('./adminCustomers'));
// 自訂資產欄位：同樣是「管理設備類型」權限
router.use('/fields', requirePermission('categories.manage'), require('./adminFields'));

// 以下全部只有管理員能進（備份檔含完整資料庫與密碼雜湊，群組權限也只有管理員能改）
router.use(requireRole('admin'));

// 權限群組
router.use('/groups', require('./adminGroups'));

// 簽核流程設定
router.use('/approval', require('./adminApproval'));

// 把舊的文字容量記錄解析成磁碟區（讓歷史資料也能畫趨勢）
router.use('/capacity-import', require('./adminCapacityImport'));

// 系統通知（發送「系統即將更新」這類訊息給使用者）
router.use('/announcements', require('./adminAnnouncements'));

// 報價請求設定（固定業務信箱、附 PDF、可見欄位、主管確認、自動提醒）
router.use('/quotes', require('./adminQuotes'));

// Email 通知設定與寄送紀錄
router.use('/mail', require('./adminMail'));

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
  const loginInfo = LoginSession.latestPerUser(recentLogins.map((u) => u.id)); // 每個人最近一次登入的使用時間
  res.render('admin/status', {
    loginInfo,
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

// ---- 登入紀錄（誰、什麼時候登入、用了多久）----
// 一個「登入」＝同一個 session 的所有使用段合併；使用時間是各段加總（閒置超過 30 分鐘就算那一段結束，不計入）
router.get('/logins', (req, res) => {
  const DAYS = [7, 30, 90, 180];
  const days = DAYS.includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
  const userId = parseInt(req.query.user, 10) || null;
  const selected = userId ? User.findById(userId) : null;
  const all = LoginSession.sessions({ days, limit: 5000 });
  const summary = LoginSession.summarize(all);
  const rows = selected ? all.filter((s) => s.user_id === selected.id).slice(0, 300) : all.slice(0, 300);
  const mine = selected ? summary.find((m) => m.user_id === selected.id) || null : null;
  res.render('admin/logins', {
    days, DAYS, selected, rows, summary, mine,
    users: User.findAll(),
    retention: LoginSession.RETENTION_DAYS,
    total: selected ? all.filter((s) => s.user_id === selected.id).length : all.length,
  });
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

// ---- 外觀設定（瀏覽器分頁圖示）----

const ICON_MIMETYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const ICON_MAX_BYTES = 2 * 1024 * 1024;
// 圖示只接受點陣圖：SVG 可能夾帶腳本或外部資源參照，而且這裡要在伺服器端解碼它，風險不值得
const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ICON_MAX_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (ICON_MIMETYPES.includes(file.mimetype)) return cb(null, true);
    const err = new Error('圖示只接受 PNG / JPEG / WebP / GIF 圖片（不支援 SVG 與 ICO），建議使用 256×256 以上的正方形 PNG');
    err.userFacing = true;
    cb(err);
  },
});

const BRANDING_FLASH = {
  saved: '分頁圖示已更新。瀏覽器會在下次載入頁面時換成新圖示（已開啟的分頁重新整理即可，有些瀏覽器要稍等一下才會更新分頁上的小圖示）',
  reset: '已還原成預設圖示',
};

function renderBranding(req, res, { error = null, status = 200 } = {}) {
  res.status(status).render('admin/branding', {
    info: BrandingService.info(),
    maxMb: ICON_MAX_BYTES / 1024 / 1024,
    ok: BRANDING_FLASH[req.query.ok] || null,
    error,
  });
}

router.get('/branding', (req, res) => renderBranding(req, res));

router.post('/branding/favicon', (req, res, next) => {
  iconUpload.single('favicon')(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE'
          ? `檔案超過 ${ICON_MAX_BYTES / 1024 / 1024}MB 上限`
          : uploadErr.userFacing ? uploadErr.message : '上傳失敗，請重新嘗試';
        return renderBranding(req, res, { error: message, status: 400 });
      }
      if (!req.file) return renderBranding(req, res, { error: '請先選擇要上傳的圖片', status: 400 });
      try {
        await BrandingService.setFromUpload(req.file.buffer, require('../middleware/upload').decodeFilename(req.file.originalname));
      } catch (err) {
        if (err.userFacing) return renderBranding(req, res, { error: err.message, status: 400 });
        throw err;
      }
      console.log(`[外觀] ${req.user.username} 更新了分頁圖示`);
      res.redirect('/admin/branding?ok=saved');
    } catch (err) {
      next(err);
    }
  });
});

router.post('/branding/favicon/reset', (req, res) => {
  BrandingService.reset();
  console.log(`[外觀] ${req.user.username} 還原了預設分頁圖示`);
  res.redirect('/admin/branding?ok=reset');
});

module.exports = router;
