const { can } = require('../utils/permissions');

// req.user 由 app.js 每個請求依資料庫即時填好（含 permissions）；這裡優先用它，
// 沒有才退回 session 裡的版本。
function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  req.user = req.user || req.session.user;
  res.locals.currentUser = req.user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
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
      return res.redirect('/login');
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
