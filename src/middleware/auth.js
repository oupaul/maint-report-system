const { can } = require('../utils/permissions');
const { safeReturnPath } = require('../utils/safeRedirect');
const { isAjax } = require('../utils/ajax');

// 沒登入就導去登入頁，順便記住原本要去的頁面（GET 才記），登入成功後回到那裡——
// 例如從通知信的連結點進來，登入後直接看到那個批次。
function redirectToLogin(req, res) {
  // 就地儲存（背景請求）遇到登入逾時：回 401 JSON，讓畫面在該列顯示「登入已逾時」，不要被導到登入頁而默默失敗
  if (isAjax(req)) return res.status(401).json({ ok: false, error: '登入已逾時，請重新整理頁面並重新登入後再儲存。' });
  if (req.method === 'GET' && req.session) {
    const target = safeReturnPath(req.originalUrl);
    if (target) req.session.returnTo = target;
  }
  return res.redirect('/login');
}

// req.user 由 app.js 每個請求依資料庫即時填好（含 permissions）；這裡優先用它，
// 沒有才退回 session 裡的版本。
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return redirectToLogin(req, res);
  }
  req.user = req.user || req.session.user;
  res.locals.currentUser = req.user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return redirectToLogin(req, res);
    }
    const user = req.user || req.session.user;
    if (user.role !== role) {
      return res.status(403).render('error', {
        title: '權限不足',
        message: '您沒有權限執行此操作',
        currentUser: req.session.user,
      });
    }
    req.user = user;
    res.locals.currentUser = req.user;
    next();
  };
}

// 需要某個功能權限（管理員永遠通過；技術人員要所屬群組有勾選這個權限）
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return redirectToLogin(req, res);
    }
    req.user = req.user || req.session.user;
    res.locals.currentUser = req.user;
    if (!can(req.user, permission)) {
      return res.status(403).render('error', {
        title: '權限不足',
        message: '您沒有權限執行此操作，如需使用請聯絡系統管理員。',
      });
    }
    next();
  };
}

module.exports = { requireLogin, requireRole, requirePermission };
