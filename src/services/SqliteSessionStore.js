const session = require('express-session');

// 用 SQLite 存 session，取代 express-session 內建的 MemoryStore：
// 1. MemoryStore 不會清掉過期的 session（官方文件也說不適合 production），會一直吃記憶體；
// 2. 服務重啟（包含每次 update.sh 更新）不會讓所有人被登出。
// 資料表在這裡建立（IF NOT EXISTS），跟業務資料放同一個資料庫檔案。
class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    `);
    this.stmtGet = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.stmtSet = db.prepare(
      'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires'
    );
    this.stmtDestroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.stmtTouch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.stmtPrune = db.prepare('DELETE FROM sessions WHERE expires <= ?');

    this.prune();
    this.timer = setInterval(() => this.prune(), 10 * 60 * 1000);
    this.timer.unref();
  }

  prune() {
    this.stmtPrune.run(Date.now());
  }

  expiresFor(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    return cookieExpires ? new Date(cookieExpires).getTime() : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.stmtGet.get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.stmtDestroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.sess));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmtSet.run(sid, JSON.stringify(sess), this.expiresFor(sess));
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmtDestroy.run(sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmtTouch.run(this.expiresFor(sess), sid);
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = SqliteSessionStore;
