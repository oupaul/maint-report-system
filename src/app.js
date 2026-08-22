console.log('[啟動] 開始載入應用程式...');

const express = require('express');
const path = require('path');
const session = require('express-session');

const config = require('./config');

const app = express();

console.log('[啟動] Express 應用程式建立完成，PORT:', config.PORT);

app.set('trust proxy', 1);

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // 除非部署時已配置 HTTPS，否則需維持 false，不然 session cookie 無法在 HTTP 下運作
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 小時
  },
}));
console.log('[啟動] Session 配置完成');

// 簽名畫布會以 base64 PNG 帶在 urlencoded body 裡送出，預設 100kb 限制太小，調高到 2mb
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (config.NODE_ENV !== 'production') {
  app.set('view cache', false);
}
console.log('[啟動] ✓ EJS 模板引擎設定完成');

// 讓所有畫面都能存取目前登入使用者與目前路徑
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    req.user = req.session.user;
  }
  res.locals.currentUser = req.session ? req.session.user : null;
  res.locals.currentPath = req.path;
  res.locals.siteName = '維護巡檢報告系統';
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
  console.log('[啟動] ✓ 路由模組載入完成');

  const { requireLogin } = require('./middleware/auth');

  // 認證路由（不需要登入）
  app.use(authRoutes);

  // 需要登入的路由
  app.use('/', dashboardRoutes);
  app.use('/assets', assetRoutes);
  app.use('/users', userRoutes);
  app.use('/batches', batchRoutes);
  app.use('/', reportRoutes); // 內部各路由自行掛 requireLogin（含 /batches/:id/report.pdf 與 /uploads/:batchId/:filename）

  console.log('[啟動] ✓ 所有路由設定完成');
} catch (err) {
  console.error('[啟動錯誤] 載入路由時發生錯誤:', err);
  console.error('[啟動錯誤] 錯誤堆疊:', err.stack);
  throw err;
}

// 錯誤處理
app.use((err, req, res, next) => {
  console.error('[錯誤處理] 捕獲到錯誤:', err.message);
  console.error('[錯誤處理] 錯誤堆疊:', err.stack);
  try {
    res.status(500).render('error', {
      title: '系統錯誤',
      message: '系統錯誤: ' + (err.message || '未知錯誤'),
    });
  } catch (renderErr) {
    res.status(500).send(`系統錯誤: ${config.NODE_ENV === 'development' ? err.message : '請稍後再試'}`);
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
