function requireLogin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  req.user = req.session.user;
  res.locals.currentUser = req.user;
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: '權限不足',
        message: '您沒有權限執行此操作',
        currentUser: req.session.user,
      });
    }
    req.user = req.session.user;
    res.locals.currentUser = req.user;
    next();
  };
}

module.exports = { requireLogin, requireRole };
