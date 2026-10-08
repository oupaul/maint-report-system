// 巡檢批次簽核流程與站內通知。全部是新增表與新增欄位，不重建既有資料表。
//
// - approval_settings：功能總開關（預設關閉，關閉時維持原本「標記為已完成」的行為）與
//   「送審的人不能簽核自己送的單」開關（預設開）。
// - approval_stages：可設定的簽核關卡（順序、名稱、負責群組；group_id 為空 = 只有管理員）。預設一關「主管審核」。
// - approval_records：每次送審（round）為每個關卡各建一筆紀錄，並「快照」關卡名稱／順序／負責群組——
//   之後管理員改關卡設定，不會影響已經送出的審核與歷史紀錄。stage_id / group_id 刻意不加外鍵，
//   這樣關卡或群組日後被刪除也不會被歷史紀錄卡住。
// - approval_events：送出／撤回／重新開啟這類「不屬於某一關」的事件，用來組成完整時間軸。
// - notifications：站內通知（每人一份，未讀/已讀）。
// - inspection_batches.approval_status：none（沒走簽核，含舊資料）/ pending / approved / returned。
//   原本的 status（draft/completed）保留：最後一關核准時才會設成 completed，所以既有的
//   頁面與 PDF 都不用改判斷方式。
module.exports = async function migrate_0010_approval_workflow(db) {
  db.exec(`
    CREATE TABLE approval_settings (
      id                  INTEGER PRIMARY KEY,
      enabled             INTEGER NOT NULL DEFAULT 0,
      block_self_approval INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO approval_settings (id) VALUES (1);

    CREATE TABLE approval_stages (
      id          INTEGER PRIMARY KEY,
      stage_order INTEGER NOT NULL,
      label       TEXT NOT NULL,
      group_id    INTEGER REFERENCES permission_groups(id),
      is_active   INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO approval_stages (stage_order, label, group_id) VALUES (1, '主管審核', NULL);

    CREATE TABLE approval_records (
      id             INTEGER PRIMARY KEY,
      batch_id       INTEGER NOT NULL REFERENCES inspection_batches(id),
      round          INTEGER NOT NULL,
      stage_id       INTEGER,
      stage_order    INTEGER NOT NULL,
      stage_label    TEXT NOT NULL,
      group_id       INTEGER,
      status         TEXT NOT NULL DEFAULT 'waiting',
      approver_id    INTEGER REFERENCES users(id),
      comment        TEXT,
      acted_at       TEXT,
      acted_as_admin INTEGER NOT NULL DEFAULT 0,
      UNIQUE(batch_id, round, stage_order)
    );

    CREATE TABLE approval_events (
      id         INTEGER PRIMARY KEY,
      batch_id   INTEGER NOT NULL REFERENCES inspection_batches(id),
      round      INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      user_id    INTEGER REFERENCES users(id),
      comment    TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE notifications (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      batch_id   INTEGER REFERENCES inspection_batches(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      message    TEXT NOT NULL,
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, id);

    ALTER TABLE inspection_batches ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE inspection_batches ADD COLUMN submitted_by INTEGER REFERENCES users(id);
    ALTER TABLE inspection_batches ADD COLUMN submitted_at TEXT;
  `);
};
