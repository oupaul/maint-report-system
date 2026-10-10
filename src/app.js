console.log('[啟動] 開始載入應用程式...');

const express = require('express');
const path = require('path');
const session = require('express-session');

const config = require('./config');
const M365AuthService = require('./services/M365AuthService');
const SqliteSessionStore = require('./services/SqliteSessionStore');
const db = require('./models/db');
const User = require('./models/User');
const ActivityTracker = require('./services/ActivityTracker');
const LoginTracker = require('./services/LoginTracker');
const Notification = require('./models/Notification');
const Announcement = require('./models/Announcement');
const PermissionGroup = require('./models/PermissionGroup');
const { can } = require('./utils/permissions');
const BackupService = require('./services/BackupService');
const HealthService = require('./services/HealthService');
const BrandingService = require('./services/BrandingService');
const { securityHeaders } = require('./middleware/securityHeaders');
const { csrfProtection } = require('./middleware/csrf');
const { isAjax } = require('./utils/ajax');

const app = express();

console.log('[啟動] Express 應用程式建立完成，PORT:', config.PORT);

app.disable('x-powered-by');

if (config.TRUST_PROXY !== false) {
  app.set('trust proxy', config.TRUST_PROXY);
}

app.use(securityHeaders);

// 給外部監控（Uptime Kuma、Cloudflare Health Check 等）用：不需登入、不建立 session、
// 只回「服務活著且資料庫可讀」，不洩漏任何系統細節（詳細狀態在登入後的「系統狀態」頁）
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ok = HealthService.liveness();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error' });
});

// 分頁圖示（公開、不建立 session），以及所有頁面 <head> 用的圖示版本字串
app.use(require('./routes/branding'));
app.use((req, res, next) => {
  res.locals.faviconVersion = BrandingService.version();
  next();
});

// 靜態檔案放在 session 前面：載入 css/js 不需要（也不該）建立或更新 session
// view 裡一律用 assetUrl('/js/x.js') 引用（網址帶內容版本碼 ?v=）：帶版本碼的可以長期快取（檔案一改網址就變），
// 沒帶的一律要求重新驗證（no-cache），避免瀏覽器或 CDN 留著舊版。serve-static 不會蓋掉已設定的 Cache-Control
app.locals.assetUrl = require('./utils/assetVersion').asset; // 不要叫 asset：編輯設備頁有同名的區域變數會蓋掉它
app.use(['/css', '/js'], (req, res, next) => {
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// M365 登入用的 MSAL.js（瀏覽器端函式庫）直接從 node_modules 提供，不依賴外部 CDN，CSP 也就不用開放外部腳本
app.get('/vendor/msal-browser.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'node_modules', '@azure', 'msal-browser', 'lib', 'msal-browser.min.js'));
});

app.use(session({
  store: new SqliteSessionStore(db),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // 'auto'：請求是 HTTPS（含透過 TRUST_PROXY 信任的反向代理）就加 Secure，純 HTTP
    // 部署（內網直連 IP:port）照常運作，不會因為設成 true 而讓 cookie 完全送不出去
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax', // 跨站來源的 POST 不會帶 cookie，是 CSRF token 之外的第二層防護
    maxAge: 24 * 60 * 60 * 1000, // 24 小時
  },
}));
console.log('[啟動] Session 配置完成');

// 簽名畫布會以 base64 PNG 帶在 urlencoded body 裡送出，預設 100kb 限制太小，調高到 2mb
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (config.NODE_ENV !== 'production') {
  app.set('view cache', false);
}
console.log('[啟動] ✓ EJS 模板引擎設定完成');

app.use(csrfProtection);

// 每個請求都重新從資料庫確認登入者：帳號被停用、角色被調整，立刻生效，不用等
// session 過期（先前只在登入當下檢查 is_active，被停用的人最長還能再用 24 小時）。
app.use((req, res, next) => {
  const sessionUser = req.session && req.session.user;
  if (sessionUser) {
    const fresh = User.findById(sessionUser.id);
    if (!fresh || !fresh.is_active) {
      delete req.session.user;
    } else {
      const current = {
        id: fresh.id,
        username: fresh.username,
        display_name: fresh.display_name,
        role: fresh.role,
        // M365 登入的 session 一律不強制改本地密碼（見 utils/session.js），這裡沿用 session 裡的值
        must_change_password: sessionUser.must_change_password ? !!fresh.must_change_password : false,
      };
      if (JSON.stringify(current) !== JSON.stringify(sessionUser)) {
        req.session.user = current;
      }
      // permissions 每個請求都依資料庫重算、不存進 session：管理員調整群組或權限後立即生效
      // group_id 與 permissions 都依資料庫即時帶入、不存進 session（群組被調整後立即生效；簽核關卡也靠 group_id 判斷誰能簽）
      req.user = { ...current, group_id: fresh.group_id || null, permissions: PermissionGroup.permissionsForUser(fresh) };
    }
  }
  res.locals.currentUser = req.user || null;
  res.locals.can = (permission) => can(req.user, permission);
  // 導覽列的通知鈴鐺：用 getter 延遲查詢，只有真的要 render 畫面時才會查資料庫
  if (req.user) {
    const uid = req.user.id;
    Object.defineProperty(res.locals, 'unreadNotifications', { get: () => Notification.unreadCount(uid), enumerable: true, configurable: true });
    Object.defineProperty(res.locals, 'activeAnnouncements', { get: () => Announcement.forBanner(), enumerable: true, configurable: true });
    Object.defineProperty(res.locals, 'recentNotifications', { get: () => Notification.listRecent(uid, 8), enumerable: true, configurable: true });
  }
  res.locals.currentPath = req.path;
  res.locals.siteName = '維護巡檢報告系統';
  // 全域設定，login.ejs 每個 render 路徑（包含各種錯誤訊息）都要用到，
  // 不用每個 res.render('login', ...) 呼叫都各自記得傳一次。
  res.locals.m365Enabled = M365AuthService.isEnabled();
  res.locals.m365 = res.locals.m365Enabled ? M365AuthService.getPublicConfig() : null;
  next();
});

// 記錄誰在線上（給「系統狀態」頁用）
app.use(ActivityTracker.middleware);
// 登入紀錄（登入時間、使用時間長度，寫進資料庫、保留 180 天）
app.use(LoginTracker.middleware);

// 必須先改密碼的帳號（初始亂數密碼、管理員代建或重設的密碼）只能進到變更密碼頁與登出
const ALLOWED_WHEN_MUST_CHANGE = new Set(['/account/password', '/logout']);
app.use((req, res, next) => {
  if (req.user && req.user.must_change_password && !ALLOWED_WHEN_MUST_CHANGE.has(req.path)) {
    return res.redirect('/account/password');
  }
  next();
});

console.log('[啟動] 開始載入路由模組...');
try {
  const authRoutes = require('./routes/auth');
  const dashboardRoutes = require('./routes/dashboard');
  const assetRoutes = require('./routes/assets');
  const userRoutes = require('./routes/users');
  const batchRoutes = require('./routes/batches');
  const reportRoutes = require('./routes/reports');
  const accountRoutes = require('./routes/account');
  const adminRoutes = require('./routes/admin');
  const notificationRoutes = require('./routes/notifications');
  console.log('[啟動] ✓ 路由模組載入完成');

  const { requireLogin } = require('./middleware/auth');

  // 認證路由（不需要登入）
  app.use(authRoutes);

  // 需要登入的路由
  app.use('/', dashboardRoutes);
  app.use('/assets', assetRoutes);
  app.use('/capacity', require('./routes/capacity'));
  app.use('/issues', require('./routes/issues'));
  app.use('/quotes', require('./routes/quotes'));
  app.use('/users', userRoutes);
  app.use('/account', accountRoutes);
  app.use('/admin', adminRoutes);
  app.use('/notifications', notificationRoutes);
  app.use('/batches', batchRoutes);
  app.use('/', reportRoutes); // 內部各路由自行掛 requireLogin（含 /batches/:id/report.pdf 與 /uploads/:batchId/:filename）

  console.log('[啟動] ✓ 所有路由設定完成');
} catch (err) {
  console.error('[啟動錯誤] 載入路由時發生錯誤:', err);
  console.error('[啟動錯誤] 錯誤堆疊:', err.stack);
  throw err;
}

// 錯誤處理：production 不把內部錯誤訊息（可能含檔案路徑、SQL 片段）回給使用者，
// 完整內容只寫進伺服器日誌；只有明確標記為 userFacing 的錯誤（例如上傳格式不符）
// 才把訊息顯示出來。
app.use((err, req, res, next) => {
  console.error('[錯誤處理] 捕獲到錯誤:', err.message);
  console.error('[錯誤處理] 錯誤堆疊:', err.stack);

  let status = err.status || 500;
  let message;
  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = '檔案超過大小上限（單張 10MB）';
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
    status = 400;
    message = '一次最多只能上傳 10 張圖片';
  } else if (err.userFacing) {
    status = 400;
    message = err.message;
  } else if (config.NODE_ENV === 'production') {
    message = '系統發生錯誤，請稍後再試；若持續發生請聯絡系統管理員。';
  } else {
    message = '系統錯誤: ' + (err.message || '未知錯誤');
  }

  if (isAjax(req)) return res.status(status).json({ ok: false, error: message });

  try {
    res.status(status).render('error', { title: '系統錯誤', message });
  } catch (renderErr) {
    res.status(status).send(message);
  }
});

// 404 處理
app.use((req, res) => {
  try {
    res.status(404).render('error', { title: '找不到頁面', message: '找不到頁面' });
  } catch (renderErr) {
    res.status(404).send('404 - 找不到頁面');
  }
});

process.on('uncaughtException', (err) => {
  console.error('未捕獲的異常:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('未處理的 Promise 拒絕:', reason);
});

const server = app.listen(config.PORT, () => {
  console.log(`\n維護巡檢報告系統`);
  console.log(`   運行於 http://localhost:${config.PORT}`);
  console.log(`   環境: ${config.NODE_ENV}\n`);
  BackupService.startScheduler();
  require('./services/QuoteService').startReminders(); // 報價請求超過幾天沒人處理就自動提醒業務
  // 已讀超過 90 天的通知定期清掉（啟動時一次，之後每天一次）
  try { Notification.prune(); } catch (e) { /* 清不掉不影響服務 */ }
  setInterval(() => { try { Notification.prune(); } catch (e) { /* ignore */ } }, 24 * 60 * 60 * 1000).unref();
  // 登入紀錄只留 180 天（啟動時一次，之後每天一次）
  try { require('./models/LoginSession').prune(); } catch (e) { /* 清不掉不影響服務 */ }
  setInterval(() => { try { require('./models/LoginSession').prune(); } catch (e) { /* ignore */ } }, 24 * 60 * 60 * 1000).unref();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n錯誤: 端口 ${config.PORT} 已被佔用`);
    process.exit(1);
  } else {
    console.error('伺服器啟動錯誤:', err);
    process.exit(1);
  }
});

module.exports = app;
