const db = require('./db');
const { nowTaipei } = require('../utils/time');

const InspectionBatch = {
  findById(id) {
    return db.prepare('SELECT * FROM inspection_batches WHERE id = ?').get(id);
  },

  findAll() {
    return db.prepare(
      `SELECT b.*, u.display_name AS created_by_name, u.username AS created_by_username
       FROM inspection_batches b
       LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.batch_date DESC, b.id DESC`
    ).all();
  },

  create({ title, batch_date, created_by, notes }) {
    const result = db.prepare(
      `INSERT INTO inspection_batches (title, batch_date, status, created_by, notes, created_at)
       VALUES (?, ?, 'draft', ?, ?, ?)`
    ).run(title, batch_date, created_by, notes || null, nowTaipei());
    return InspectionBatch.findById(result.lastInsertRowid);
  },

  complete(id) {
    db.prepare(
      `UPDATE inspection_batches SET status = 'completed', completed_at = ?,
         approval_status = CASE WHEN approval_status = 'returned' THEN 'none' ELSE approval_status END
       WHERE id = ?`
    ).run(nowTaipei(), id);
    return InspectionBatch.findById(id);
  },

  addAsset(batchId, assetId) {
    db.prepare(
      'INSERT OR IGNORE INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)'
    ).run(batchId, assetId);
  },

  // 每個批次涵蓋哪些客戶（由設備決定）：Map(batchId → { customers: [{id,name}], unassigned: 未指定客戶的設備數, total })
  customerSummary() {
    const rows = db.prepare(
      `SELECT ba.batch_id, a.customer_id, cu.name, COUNT(*) AS n
       FROM inspection_batch_assets ba JOIN assets a ON a.id = ba.asset_id LEFT JOIN customers cu ON cu.id = a.customer_id
       GROUP BY ba.batch_id, a.customer_id ORDER BY cu.name COLLATE NOCASE ASC`
    ).all();
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.batch_id)) map.set(r.batch_id, { customers: [], unassigned: 0, total: 0 });
      const m = map.get(r.batch_id);
      m.total += r.n;
      if (r.customer_id) m.customers.push({ id: r.customer_id, name: r.name }); else m.unassigned += r.n;
    }
    return map;
  },

  getAssets(batchId) {
    return db.prepare(
      // 批次可以涵蓋多家客戶：依客戶（未指定客戶排最後）→ 類型 → 名稱排序，填寫頁、摘要頁與 PDF 都用這個順序，同一家客戶的設備會排在一起
      `SELECT a.*, cu.name AS customer_name, cu.tax_id AS customer_tax_id FROM inspection_batch_assets ba
       JOIN assets a ON a.id = ba.asset_id
       LEFT JOIN customers cu ON cu.id = a.customer_id
       LEFT JOIN asset_categories ac ON ac.code = a.category
       WHERE ba.batch_id = ?
       ORDER BY (cu.name IS NULL) ASC, cu.name COLLATE NOCASE ASC, ac.sort_order ASC, a.category ASC, a.name ASC`
    ).all(batchId);
  },
};

module.exports = InspectionBatch;
