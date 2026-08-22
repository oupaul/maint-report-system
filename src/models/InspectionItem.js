const db = require('./db');
const { nowTaipei } = require('../utils/time');

const InspectionItem = {
  findById(id) {
    return db.prepare('SELECT * FROM inspection_items WHERE id = ?').get(id);
  },

  findByBatch(batchId) {
    return db.prepare(
      `SELECT ii.*, a.name AS asset_name, a.category AS asset_category,
              ci.code AS checklist_code, ci.label AS checklist_label, ci.sort_order
       FROM inspection_items ii
       JOIN assets a ON a.id = ii.asset_id
       JOIN checklist_items ci ON ci.id = ii.checklist_item_id
       WHERE ii.batch_id = ?
       ORDER BY a.category ASC, a.name ASC, ci.sort_order ASC`
    ).all(batchId);
  },

  findOne(batchId, assetId, checklistItemId) {
    return db.prepare(
      `SELECT * FROM inspection_items
       WHERE batch_id = ? AND asset_id = ? AND checklist_item_id = ?`
    ).get(batchId, assetId, checklistItemId);
  },

  // 截圖改存在 inspection_item_photos（一對多，見 InspectionItemPhoto model），
  // 本 model 只處理 inspection_items 本身的欄位。
  upsert({
    batch_id, asset_id, checklist_item_id, status, value_text, note,
    source, source_ref, recorded_by,
  }) {
    const existing = InspectionItem.findOne(batch_id, asset_id, checklist_item_id);

    if (existing) {
      db.prepare(
        `UPDATE inspection_items SET
           status = ?, value_text = ?, note = ?,
           source = ?, source_ref = ?, recorded_by = ?, recorded_at = ?
         WHERE id = ?`
      ).run(
        status, value_text || null, note || null,
        source || 'manual', source_ref || null, recorded_by || null,
        nowTaipei(),
        existing.id
      );
      return InspectionItem.findById(existing.id);
    }

    const result = db.prepare(
      `INSERT INTO inspection_items (
         batch_id, asset_id, checklist_item_id, status, value_text, note,
         source, source_ref, recorded_by, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      batch_id, asset_id, checklist_item_id, status, value_text || null, note || null,
      source || 'manual', source_ref || null, recorded_by || null, nowTaipei()
    );
    return InspectionItem.findById(result.lastInsertRowid);
  },
};

module.exports = InspectionItem;
