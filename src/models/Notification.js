const db = require('./db');
const { nowTaipei } = require('../utils/time');

const RETENTION_DAYS = 90;

const Notification = {
  // 回傳新通知的 id（Email 寄送要用它把結果寫回同一筆）
  create(userId, { batchId = null, type, title, message }) {
    return db.prepare(
      `INSERT INTO notifications (user_id, batch_id, type, title, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, batchId, type, title, message, nowTaipei()).lastInsertRowid;
  },

  findById(id) {
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  },

  setEmailResult(id, status, error = null) {
    db.prepare('UPDATE notifications SET email_status = ?, email_error = ? WHERE id = ?')
      .run(status, error ? String(error).slice(0, 1000) : null, id);
  },

  // 管理員「Email 通知」頁的寄送紀錄
  listForLog(limit = 50) {
    return db.prepare(
      `SELECT n.*, u.username, u.display_name, u.email, u.m365_email
       FROM notifications n JOIN users u ON u.id = n.user_id
       ORDER BY n.id DESC LIMIT ?`
    ).all(limit);
  },

  listRecent(userId, limit = 8) {
    return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
  },

  unreadCount(userId) {
    return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;
  },

  findForUser(id, userId) {
    return db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
  },

  markRead(id, userId) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(id, userId);
  },

  markAllRead(userId) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
  },

  // 只清「已讀且超過保留天數」的，未讀的永遠留著
  prune() {
    const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - RETENTION_DAYS * 86400 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    return db.prepare('DELETE FROM notifications WHERE is_read = 1 AND created_at < ?').run(cutoff).changes;
  },
};

module.exports = Notification;
