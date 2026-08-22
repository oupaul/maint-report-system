const db = require('./db');

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

  create({ username, password_hash, display_name, role, m365_email }) {
    const result = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, m365_email, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(username, password_hash, display_name || null, role, (m365_email || '').trim() || null);
    return User.findById(result.lastInsertRowid);
  },

  update(id, { display_name, role, is_active, m365_email }) {
    db.prepare(
      `UPDATE users SET display_name = ?, role = ?, is_active = ?, m365_email = ? WHERE id = ?`
    ).run(display_name || null, role, is_active ? 1 : 0, (m365_email || '').trim() || null, id);
    return User.findById(id);
  },

  updatePassword(id, password_hash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  },
};

module.exports = User;
