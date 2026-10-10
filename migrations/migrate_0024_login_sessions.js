// 登入紀錄（誰、什麼時候登入、用了多久）。一列＝一段「使用時間」：
// - 登入時建立一列；使用中定期更新 last_seen_at（同一個登入最多每分鐘寫一次，不是每個請求都寫）
// - 主動登出：寫入 ended_at、end_reason='logout'
// - 閒置超過 30 分鐘後又回來操作：上一段以最後一次操作時間結束（end_reason='idle'），再開新的一列（同一個 session_key）
// session_key 是 session id 的雜湊（不存原始 session id，資料庫外洩也不能拿來冒用登入）。
// 使用時間長度＝(ended_at 或 last_seen_at) 減 started_at；各段加總就是這次登入的實際使用時間（扣掉閒置）。
// 只留 180 天，過期的由服務定期清掉。這個功能啟用之前的登入沒有紀錄。
module.exports = async function migrate_0024_login_sessions(db) {
  db.exec(`
    CREATE TABLE login_sessions (
      id           INTEGER PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      session_key  TEXT NOT NULL,
      method       TEXT,
      started_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ended_at     TEXT,
      end_reason   TEXT,
      ip           TEXT,
      agent        TEXT
    );
    CREATE INDEX idx_login_sessions_user ON login_sessions(user_id, started_at);
    CREATE INDEX idx_login_sessions_started ON login_sessions(started_at);
    CREATE INDEX idx_login_sessions_key ON login_sessions(session_key);
  `);
};
