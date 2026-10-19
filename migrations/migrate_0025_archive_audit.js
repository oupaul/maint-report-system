// 1. 批次封存：inspection_batches.archived_at／archived_by。封存＝從批次清單與儀表板隱藏（可還原），
//    資料、報告、待處理項目與趨勢照常保留（歷史資料不會因為封存而消失）。
// 2. 稽核紀錄 audit_log：誰、什麼時候、刪除／封存了什麼。username 與 label 當下快照，沒有外鍵——
//    使用者被刪除之後紀錄還在。保留 180 天，由服務定期清掉。
module.exports = async function migrate_0025_archive_audit(db) {
  db.exec(`
    ALTER TABLE inspection_batches ADD COLUMN archived_at TEXT;
    ALTER TABLE inspection_batches ADD COLUMN archived_by INTEGER;
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY,
      at          TEXT NOT NULL,
      user_id     INTEGER,
      username    TEXT,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   INTEGER,
      target_label TEXT,
      detail      TEXT
    );
    CREATE INDEX idx_audit_log_at ON audit_log(at);
    CREATE INDEX idx_audit_log_action ON audit_log(action, at);
  `);
};
