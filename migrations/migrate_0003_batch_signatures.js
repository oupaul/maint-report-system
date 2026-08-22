// 巡檢批次簽名：工程師／主管各一筆，綁定登入帳號（不開放自由填名），
// 報告在事後製作提供，不強制同一時間/同一裝置簽署，因此獨立成一張表，
// 各自登入後隨時可以簽署或重新簽署。

module.exports = async function migrate_0003_batch_signatures(db) {
  db.exec(`
    CREATE TABLE batch_signatures (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES inspection_batches(id),
      role TEXT NOT NULL CHECK(role IN ('engineer','supervisor')),
      user_id INTEGER NOT NULL REFERENCES users(id),
      signature_path TEXT NOT NULL,
      signed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(batch_id, role)
    );
  `);
};
