const db = require('./db');
const { nowTaipei } = require('../utils/time');

const User = {
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  // M365 登入用 email 比對帳號，大小寫不影響比對（Azure AD 的 UPN/email 視為
  // 大小寫不敏感），資料庫存的是使用者/管理員輸入的原始大小寫。
  findByM365Email(email) {
    return db.prepare('SELECT * FROM users WHERE lower(m365_email) = lower(?)').get(email);
  },

  findAll() {
    return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  },

  // 管理員代建的帳號，密碼是管理員設定的、本人不是自己選的，第一次登入強制改密碼
  create({ username, password_hash, display_name, role, m365_email }) {
    const result = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, m365_email, is_active, must_change_password, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?)`
    ).run(username, password_hash, display_name || null, role, (m365_email || '').trim() || null, nowTaipei());
    return User.findById(result.lastInsertRowid);
  },

  update(id, { display_name, role, is_active, m365_email }) {
    db.prepare(
      `UPDATE users SET display_name = ?, role = ?, is_active = ?, m365_email = ? WHERE id = ?`
    ).run(display_name || null, role, is_active ? 1 : 0, (m365_email || '').trim() || null, id);
    return User.findById(id);
  },

  recordLogin(id) {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowTaipei(), id);
  },

  // mustChange：本人自己改密碼 → false（清掉強制改密碼旗標）；管理員幫別人重設 → true
  updatePassword(id, password_hash, { mustChange = false } = {}) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?')
      .run(password_hash, mustChange ? 1 : 0, id);
  },
};

module.exports = User;
