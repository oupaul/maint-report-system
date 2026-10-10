const User = require('../models/User');

// 登入成功後換一組新的 session id（同時清掉舊 session 內容）：防止 session fixation——
// 攻擊者事先塞給受害者一組已知的 session id，登入後如果沿用，攻擊者就等於登入了。
function establishSession(req, user, { viaSso = false } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        // M365 登入的人密碼不是他自己在用，不強制改本地密碼
        must_change_password: viaSso ? false : !!user.must_change_password,
      };
      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        try { User.recordLogin(user.id); } catch (e) { /* 只是記錄用，失敗不影響登入 */ }
        require('../services/LoginTracker').start(req, user, viaSso ? 'm365' : 'password');
        resolve();
      });
    });
  });
}

module.exports = { establishSession };
