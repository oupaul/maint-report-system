// 報價請求：工程師在異常／警告的檢查項目上按「通知業務報價」，系統建立一張有追蹤狀態的請求並通知業務。
// - quote_requests：請求本身（設備資料與項目內容都是「送出當下的快照」，之後批次被鎖定或項目被修改都不會變）；
//   status：pending_confirm（待主管確認，選用）→ sent（已送出）→ processing（處理中）→ quoted（已報價）→ closed（已結案）／cancelled（已取消）。
// - quote_request_items：這張請求包含的檢查項目（同一台設備可以合併多項）；quote_request_photos：送出時複製一份的截圖
//   （原截圖之後被刪除也不影響）；quote_request_events：處理紀錄（時間軸）。
// - quote_settings：單列設定（固定業務信箱、是否附 PDF、業務看得到哪些設備欄位、是否需要主管確認、自動提醒天數）。
// - notifications.link：通知可以指到任意站內頁面（原本只能指到批次）。
// - 預先建立「業務」權限群組（權限 quotes.receive），把人加進去就會收到報價請求；不需要可以修改或刪除。
module.exports = async function migrate_0019_quote_requests(db) {
  db.exec(`
    CREATE TABLE quote_settings (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      enabled         INTEGER NOT NULL DEFAULT 1,
      sales_email     TEXT,
      attach_pdf      INTEGER NOT NULL DEFAULT 1,
      show_ip         INTEGER NOT NULL DEFAULT 0,
      show_mac        INTEGER NOT NULL DEFAULT 0,
      show_serial     INTEGER NOT NULL DEFAULT 1,
      show_purchase   INTEGER NOT NULL DEFAULT 1,
      show_custom     INTEGER NOT NULL DEFAULT 1,
      require_confirm INTEGER NOT NULL DEFAULT 0,
      remind_days     INTEGER NOT NULL DEFAULT 3
    );
    INSERT INTO quote_settings (id) VALUES (1);

    CREATE TABLE quote_requests (
      id                  INTEGER PRIMARY KEY,
      asset_id            INTEGER NOT NULL REFERENCES assets(id),
      asset_snapshot      TEXT NOT NULL,
      source_batch_id     INTEGER REFERENCES inspection_batches(id),
      urgency             TEXT NOT NULL DEFAULT 'normal',
      description         TEXT,
      status              TEXT NOT NULL,
      requested_by        INTEGER NOT NULL REFERENCES users(id),
      requested_at        TEXT NOT NULL,
      sent_at             TEXT,
      confirmed_by        INTEGER REFERENCES users(id),
      confirmed_at        TEXT,
      assigned_to         INTEGER REFERENCES users(id),
      first_response_at   TEXT,
      quoted_at           TEXT,
      quote_no            TEXT,
      quote_amount        REAL,
      sales_note          TEXT,
      closed_at           TEXT,
      closed_by           INTEGER REFERENCES users(id),
      cancelled_at        TEXT,
      reminder_count      INTEGER NOT NULL DEFAULT 0,
      auto_reminder_count INTEGER NOT NULL DEFAULT 0,
      last_reminded_at    TEXT,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX idx_quote_requests_status ON quote_requests(status);
    CREATE INDEX idx_quote_requests_requester ON quote_requests(requested_by);
    CREATE INDEX idx_quote_requests_asset ON quote_requests(asset_id);

    CREATE TABLE quote_request_items (
      id                 INTEGER PRIMARY KEY,
      request_id         INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      inspection_item_id INTEGER,
      asset_id           INTEGER NOT NULL,
      checklist_item_id  INTEGER NOT NULL,
      label              TEXT NOT NULL,
      status             TEXT NOT NULL,
      display            TEXT,
      note               TEXT,
      extra              TEXT,
      batch_id           INTEGER,
      batch_title        TEXT,
      batch_date         TEXT
    );
    CREATE INDEX idx_quote_items_request ON quote_request_items(request_id);
    CREATE INDEX idx_quote_items_pair ON quote_request_items(asset_id, checklist_item_id);

    CREATE TABLE quote_request_photos (
      id         INTEGER PRIMARY KEY,
      item_id    INTEGER NOT NULL REFERENCES quote_request_items(id) ON DELETE CASCADE,
      path       TEXT NOT NULL,
      width      INTEGER,
      height     INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE quote_request_events (
      id         INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES quote_requests(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id),
      action     TEXT NOT NULL,
      detail     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_quote_events_request ON quote_request_events(request_id, id);

    ALTER TABLE notifications ADD COLUMN link TEXT;
  `);

  // 「業務」群組：只有「接收與處理報價請求」權限（已存在同名群組就不動）
  if (!db.prepare("SELECT 1 FROM permission_groups WHERE name = '業務'").get()) {
    const r = db.prepare('INSERT INTO permission_groups (name, description) VALUES (?, ?)')
      .run('業務', '會收到工程師送出的報價請求，並可接手、報價、結案');
    db.prepare('INSERT INTO permission_group_perms (group_id, permission) VALUES (?, ?)').run(r.lastInsertRowid, 'quotes.receive');
  }
};
