const db = require('./db');

const InspectionItemPhoto = {
  findById(id) {
    return db.prepare('SELECT * FROM inspection_item_photos WHERE id = ?').get(id);
  },

  findByItemId(itemId) {
    return db.prepare(
      'SELECT * FROM inspection_item_photos WHERE inspection_item_id = ? ORDER BY sort_order ASC, id ASC'
    ).all(itemId);
  },

  // 一次撈多個 inspection_item 的照片，用來在批次列表/PDF 這種一次要顯示多個項目的畫面
  // 避免每個項目各自查一次 DB（N+1）。回傳依 inspection_item_id 分組的 Map。
  findByItemIds(itemIds) {
    const grouped = new Map();
    if (itemIds.length === 0) return grouped;

    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM inspection_item_photos
       WHERE inspection_item_id IN (${placeholders})
       ORDER BY inspection_item_id ASC, sort_order ASC, id ASC`
    ).all(...itemIds);

    for (const row of rows) {
      if (!grouped.has(row.inspection_item_id)) grouped.set(row.inspection_item_id, []);
      grouped.get(row.inspection_item_id).push(row);
    }
    return grouped;
  },

  // 先插入一筆佔位資料以取得 id（檔名需要用到 photo id），轉檔完成後再用 updateFile 補上實際路徑/尺寸
  create({ inspection_item_id, sort_order }) {
    const result = db.prepare(
      `INSERT INTO inspection_item_photos (inspection_item_id, path, format, sort_order)
       VALUES (?, '', '', ?)`
    ).run(inspection_item_id, sort_order || 0);
    return InspectionItemPhoto.findById(result.lastInsertRowid);
  },

  updateFile(id, { path, format, width, height }) {
    db.prepare(
      `UPDATE inspection_item_photos SET path = ?, format = ?, width = ?, height = ? WHERE id = ?`
    ).run(path, format, width || null, height || null, id);
    return InspectionItemPhoto.findById(id);
  },

  remove(id) {
    db.prepare('DELETE FROM inspection_item_photos WHERE id = ?').run(id);
  },
};

module.exports = InspectionItemPhoto;
