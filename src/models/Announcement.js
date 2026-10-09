const db = require('./db');
const { nowTaipei } = require('../utils/time');

const MAX_MESSAGE = 300;
const DURATIONS = [15, 30, 60, 180, 1440]; // 橫幅顯示多久（分鐘）
const LEVELS = ['info', 'warning'];
const TARGETS = ['online', 'all'];

function taipeiPlusMinutes(min) {
  return new Date(Date.now() + 8 * 3600 * 1000 + min * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const Announcement = {
  MAX_MESSAGE, DURATIONS, LEVELS, TARGETS,

  create({ message, level, target, recipients, emailed, createdBy, durationMin }) {
    const r = db.prepare(
      `INSERT INTO announcements (message, level, target, recipients, emailed, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(message, level, target, recipients, emailed ? 1 : 0, createdBy, nowTaipei(), taipeiPlusMinutes(durationMin));
    return r.lastInsertRowid;
  },

  // 現在還在顯示的（沒到期、沒被撤回），最新的在前
  active() {
    return db.prepare(
      'SELECT * FROM announcements WHERE cancelled_at IS NULL AND expires_at > ? ORDER BY id DESC'
    ).all(nowTaipei());
  },

  cancel(id) {
    return db.prepare('UPDATE announcements SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL').run(nowTaipei(), id).changes > 0;
  },

  recent(limit = 20) {
    return db.prepare(
      `SELECT a.*, u.display_name AS by_name, u.username AS by_username
       FROM announcements a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.id DESC LIMIT ?`
    ).all(limit);
  },

  findById(id) {
    return db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  },

  // 給橫幅用的精簡格式
  forBanner() {
    return Announcement.active().map(a => ({ id: a.id, message: a.message, level: a.level, at: a.created_at.slice(11, 16) }));
  },

  stateOf(a) {
    if (a.cancelled_at) return 'cancelled';
    return a.expires_at > nowTaipei() ? 'active' : 'expired';
  },
};

module.exports = Announcement;
