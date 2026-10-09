// 「處理建議」（待處理項目分流）：警告不一定要報價，工程師可以對每個警告／異常項目選：
//   observe 持續觀察（有複查日期，到期前不再催）／scheduled 排程處理（預計日期）／quote 需要報價／resolved 已處理或不需處理。
// - issue_triage：跟著「設備＋檢查項目」走（不是某一次巡檢），所以下次巡檢同一項目還是警告時仍記得當初的判斷。
//   set_batch_date／status_at_set 記錄標記當下最新一次巡檢的日期與狀態，用來判斷「之後惡化了」「是新的一輪問題」而讓它重新浮出來。
// - issue_triage_log：每次修改的紀錄（誰、什麼時候、改成什麼）。
// - quote_settings.allow_warning_direct：警告項目能不能不先分流、直接通知業務報價（預設不行）。
module.exports = async function migrate_0021_issue_triage(db) {
  db.exec(`
    CREATE TABLE issue_triage (
      id                INTEGER PRIMARY KEY,
      asset_id          INTEGER NOT NULL REFERENCES assets(id),
      checklist_item_id INTEGER NOT NULL REFERENCES checklist_items(id),
      disposition       TEXT NOT NULL,
      note              TEXT,
      review_date       TEXT,
      status_at_set     TEXT,
      set_batch_date    TEXT,
      updated_by        INTEGER REFERENCES users(id),
      updated_at        TEXT NOT NULL,
      UNIQUE (asset_id, checklist_item_id)
    );
    CREATE TABLE issue_triage_log (
      id                INTEGER PRIMARY KEY,
      asset_id          INTEGER NOT NULL,
      checklist_item_id INTEGER NOT NULL,
      disposition       TEXT,
      note              TEXT,
      review_date       TEXT,
      user_id           INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL
    );
    CREATE INDEX idx_issue_triage_log_pair ON issue_triage_log(asset_id, checklist_item_id, id);
    ALTER TABLE quote_settings ADD COLUMN allow_warning_direct INTEGER NOT NULL DEFAULT 0;
  `);
};
