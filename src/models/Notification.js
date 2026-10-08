const db = require('./db');
const { nowTaipei } = require('../utils/time');

const RETENTION_DAYS = 90;

const Notification = {
  create(userId, { batchId = null, type, title, message }) {
    db.prepare(
      `INSERT INTO notifications (user_id, batch_id, type, title, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, batchId, type, title, message, nowTaipei());
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
