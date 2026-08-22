const db = require('./db');

const User = {
  findById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  findAll() {
    return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  },

  create({ username, password_hash, display_name, role }) {
    const result = db.prepare(
      `INSERT INTO users (username, password_hash, display_name, role, is_active)
       VALUES (?, ?, ?, ?, 1)`
    ).run(username, password_hash, display_name || null, role);
    return User.findById(result.lastInsertRowid);
  },

  update(id, { display_name, role, is_active }) {
    db.prepare(
      `UPDATE users SET display_name = ?, role = ?, is_active = ? WHERE id = ?`
    ).run(display_name || null, role, is_active ? 1 : 0, id);
    return User.findById(id);
  },

  updatePassword(id, password_hash) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, id);
  },
};

module.exports = User;
