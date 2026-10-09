const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const User = require('../models/User');
const UserSignature = require('../models/UserSignature');
const { safeReturnPath } = require('../utils/safeRedirect');
const AuthService = require('../services/AuthService');
const { establishSession } = require('../utils/session');
const { validatePasswordStrength, MIN_LENGTH } = require('../utils/password');

function renderForm(res, { error = null, success = null, status = 200 } = {}) {
  res.status(status).render('account/password', { error, success, minLength: MIN_LENGTH });
}

router.get('/password', requireLogin, (req, res) => {
  renderForm(res);
});

router.post('/password', requireLogin, async (req, res, next) => {
  try {
    const { current_password: current, new_password: next1, confirm_password: confirm } = req.body;
    const user = User.findById(req.user.id);

    if (!user || !(await AuthService.verifyPassword(user.password_hash, current || ''))) {
      return renderForm(res, { error: '目前的密碼不正確', status: 400 });
    }
    if (next1 !== confirm) {
      return renderForm(res, { error: '兩次輸入的新密碼不一致', status: 400 });
    }
    if (next1 === current) {
      return renderForm(res, { error: '新密碼不可以跟目前的密碼相同', status: 400 });
    }
    const weak = validatePasswordStrength(next1, { username: user.username });
    if (weak) {
      return renderForm(res, { error: weak, status: 400 });
    }

    User.updatePassword(user.id, await AuthService.hashPassword(next1), { mustChange: false });
    // 改完密碼換一組新的 session id，舊的（可能已經外流的）session 就此作廢
    await establishSession(req, User.findById(user.id));
    res.redirect('/?password_changed=1');
  } catch (err) {
    next(err);
  }
});

// 我的預設簽名（簽名視窗裡「使用這個簽名」用）：只有本人取得到自己的，沒有任何依 id 取別人簽名的網址
router.get('/signature.png', requireLogin, (req, res) => {
  const row = UserSignature.get(req.user.id);
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-cache' });
  res.send(row.image);
});

router.post('/signature/delete', requireLogin, (req, res) => {
  UserSignature.remove(req.user.id);
  res.redirect(safeReturnPath(req.body.return) || '/');
});

module.exports = router;
