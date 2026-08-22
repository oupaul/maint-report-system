const db = require('./db');

const BatchSignature = {
  findByBatchId(batchId) {
    return db.prepare(
      `SELECT bs.*, u.display_name, u.username
       FROM batch_signatures bs
       JOIN users u ON u.id = bs.user_id
       WHERE bs.batch_id = ?`
    ).all(batchId);
  },

  // role 每個 batch 只有一筆（UNIQUE(batch_id, role)），重新簽署直接覆蓋舊紀錄
  upsert({ batch_id, role, user_id, signature_path }) {
    db.prepare(
      `INSERT INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(batch_id, role) DO UPDATE SET
         user_id = excluded.user_id,
         signature_path = excluded.signature_path,
         signed_at = excluded.signed_at`
    ).run(batch_id, role, user_id, signature_path);

    return db.prepare(
      'SELECT * FROM batch_signatures WHERE batch_id = ? AND role = ?'
    ).get(batch_id, role);
  },
};

module.exports = BatchSignature;
