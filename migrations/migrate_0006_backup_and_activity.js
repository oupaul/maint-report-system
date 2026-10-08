// 1. backup_settings：網頁「備份管理」的排程設定（單一列）與最近一次備份結果。
//    新安裝與既有安裝都預設「啟用、每天 02:00（台北時間）、保留 14 天」——先前沒有任何預設排程，
//    資料只靠有人記得手動備份。frequency / weekday 的合法值在應用程式端驗證，不下 CHECK 約束。
// 2. users.last_login_at：記錄最近一次登入時間，給「系統狀態」頁顯示。
module.exports = async function migrate_0006_backup_and_activity(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_settings (
      id             INTEGER PRIMARY KEY,
      enabled        INTEGER NOT NULL DEFAULT 1,
      frequency      TEXT    NOT NULL DEFAULT 'daily',
      run_time       TEXT    NOT NULL DEFAULT '02:00',
      weekday        INTEGER NOT NULL DEFAULT 0,
      retention_days INTEGER NOT NULL DEFAULT 14,
      last_slot      TEXT,
      last_run_at    TEXT,
      last_status    TEXT,
      last_message   TEXT,
      last_file      TEXT,
      last_trigger   TEXT
    );
    INSERT OR IGNORE INTO backup_settings (id) VALUES (1);
  `);

  const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!columns.includes('last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  }
};
