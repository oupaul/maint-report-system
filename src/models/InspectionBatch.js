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
      `UPDATE inspection_batches SET status = 'completed', completed_at = ? WHERE id = ?`
    ).run(nowTaipei(), id);
    return InspectionBatch.findById(id);
  },

  addAsset(batchId, assetId) {
    db.prepare(
      'INSERT OR IGNORE INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)'
    ).run(batchId, assetId);
  },

  getAssets(batchId) {
    return db.prepare(
      `SELECT a.* FROM inspection_batch_assets ba
       JOIN assets a ON a.id = ba.asset_id
       WHERE ba.batch_id = ?
       ORDER BY a.category ASC, a.name ASC`
    ).all(batchId);
  },
};

module.exports = InspectionBatch;
