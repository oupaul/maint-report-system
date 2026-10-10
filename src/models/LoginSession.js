// 登入紀錄（login_sessions）：一列＝一段使用時間。詳細規則見 migration 0024。
// 「登入」＝同一個 session_key 的所有列合併（中間閒置過 30 分鐘會分成多段），使用時間是各段加總（不含閒置）。
const db = require('./db');
const { nowTaipei, formatTaipei } = require('../utils/time');

const RETENTION_DAYS = 180;
const ONLINE_MS = 5 * 60 * 1000;   // 5 分鐘內有操作＝線上（跟「目前在線上」同一個定義）
const IDLE_MS = 30 * 60 * 1000;    // 超過 30 分鐘沒操作＝這一段使用結束

// 資料庫裡的台北時間字串 → 毫秒（UTC）
const toMs = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + 'Z') - 8 * 3600 * 1000 : 0);

const SESSION_SQL = `
  SELECT g.session_key, g.user_id, g.started_at, g.last_at, g.secs, g.segs, g.method,
         l.ended_at, l.end_reason, l.last_seen_at, l.ip, l.agent,
         u.username, u.display_name
  FROM (
    SELECT session_key, user_id, MIN(started_at) AS started_at,
           MAX(COALESCE(ended_at, last_seen_at)) AS last_at,
           SUM((julianday(COALESCE(ended_at, last_seen_at)) - julianday(started_at)) * 86400) AS secs,
           COUNT(*) AS segs, MAX(method) AS method, MAX(id) AS last_id
    FROM login_sessions
    WHERE started_at >= ? __USER__
    GROUP BY session_key
  ) g
  JOIN login_sessions l ON l.id = g.last_id
  LEFT JOIN users u ON u.id = g.user_id
  ORDER BY g.started_at DESC, g.last_id DESC
  LIMIT ?`;

// 線上／閒置中／已登出／閒置逾時
function statusOf(row, nowMs = Date.now()) {
  if (row.ended_at) return row.end_reason === 'logout' ? 'logout' : 'idle_end';
  const age = nowMs - toMs(row.last_seen_at);
  if (age <= ONLINE_MS) return 'online';
  if (age <= IDLE_MS) return 'idle_now';
  return 'idle_end'; // 超過 30 分鐘沒操作，也沒登出（直接關掉瀏覽器）
}

const LoginSession = {
  RETENTION_DAYS, ONLINE_MS, IDLE_MS, toMs, statusOf,

  create({ userId, key, method = null, ip = null, agent = null }) {
    const now = nowTaipei();
    return db.prepare(
      `INSERT INTO login_sessions (user_id, session_key, method, started_at, last_seen_at, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, key, method, now, now, ip, agent).lastInsertRowid;
  },

  touch(id, at = nowTaipei()) {
    db.prepare('UPDATE login_sessions SET last_seen_at = ? WHERE id = ? AND ended_at IS NULL').run(at, id);
  },

  close(id, endedAt, reason) {
    db.prepare(
      `UPDATE login_sessions SET ended_at = ?, end_reason = ?, last_seen_at = CASE WHEN last_seen_at > ? THEN last_seen_at ELSE ? END WHERE id = ? AND ended_at IS NULL`
    ).run(endedAt, reason, endedAt, endedAt, id);
  },

  findOpenByKey(key) {
    return db.prepare('SELECT * FROM login_sessions WHERE session_key = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1').get(key);
  },

  // 最近 days 天的登入（已合併各段），新的在前；userId 可省略
  sessions({ userId = null, days = 30, limit = 300 } = {}) {
    const since = formatTaipei(Date.now() - days * 86400000);
    const sql = SESSION_SQL.replace('__USER__', userId ? 'AND user_id = ?' : '');
    const args = userId ? [since, userId, limit] : [since, limit];
    const nowMs = Date.now();
    return db.prepare(sql).all(...args).map((r) => ({ ...r, secs: Math.max(0, Math.round(r.secs || 0)), status: statusOf(r, nowMs) }));
  },

  // 每個使用者最近一次登入（系統狀態頁用）
  latestPerUser(userIds) {
    const out = new Map();
    for (const id of userIds) {
      const [row] = LoginSession.sessions({ userId: id, days: RETENTION_DAYS, limit: 1 });
      if (row) out.set(id, row);
    }
    return out;
  },

  // 依使用者彙總：登入次數、累計使用時間、平均每次、最近一次
  summarize(sessionRows) {
    const map = new Map();
    for (const s of sessionRows) {
      if (!map.has(s.user_id)) map.set(s.user_id, { user_id: s.user_id, username: s.username, display_name: s.display_name, logins: 0, secs: 0, last: s.started_at });
      const m = map.get(s.user_id);
      m.logins++;
      m.secs += s.secs;
      if (s.started_at > m.last) m.last = s.started_at;
    }
    return [...map.values()].map((m) => ({ ...m, avg: m.logins ? Math.round(m.secs / m.logins) : 0 })).sort((a, b) => b.secs - a.secs);
  },

  prune() {
    const before = formatTaipei(Date.now() - RETENTION_DAYS * 86400000);
    return db.prepare('DELETE FROM login_sessions WHERE started_at < ?').run(before).changes;
  },
};

module.exports = LoginSession;
