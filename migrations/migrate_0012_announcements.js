// 系統通知（管理員對使用者發送「系統即將更新」這類訊息）：全部是新增表，不動既有資料表。
// - 發送時會有一則限時的「橫幅」顯示在所有登入使用者的每一頁最上方（到期或被撤回就消失），
//   同時依對象寫入每個人的站內通知（可選擇再寄 Email），沒在線上的人下次登入也看得到。
// - expires_at / created_at 一律是台北時間字串（跟其他表一致），可以直接用字串比較大小。
module.exports = async function migrate_0012_announcements(db) {
  db.exec(`
    CREATE TABLE announcements (
      id           INTEGER PRIMARY KEY,
      message      TEXT NOT NULL,
      level        TEXT NOT NULL DEFAULT 'info',
      target       TEXT NOT NULL DEFAULT 'online',
      recipients   INTEGER NOT NULL DEFAULT 0,
      emailed      INTEGER NOT NULL DEFAULT 0,
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT NOT NULL,
      expires_at   TEXT NOT NULL,
      cancelled_at TEXT
    );
    CREATE INDEX idx_announcements_expires ON announcements(expires_at);
  `);
};
