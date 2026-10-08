const db = require('./db');
const { nowTaipei } = require('../utils/time');

const Asset = {
  findById(id) {
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  },

  // 依類型管理頁設定的排序顯示（類型排序 → 名稱）
  findAll({ includeInactive = false } = {}) {
    return db.prepare(
      `SELECT a.* FROM assets a LEFT JOIN asset_categories ac ON ac.code = a.category
       ${includeInactive ? '' : 'WHERE a.is_active = 1'}
       ORDER BY ac.sort_order ASC, a.category ASC, a.name ASC`
    ).all();
  },

  // 已經有檢查紀錄的資產不能改類型：舊紀錄是對應「原本類型」的檢查項目，改了類型就對不上
  hasRecords(id) {
    return !!db.prepare('SELECT 1 FROM inspection_items WHERE asset_id = ? LIMIT 1').get(id);
  },

  findByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...ids);
  },

  create({ name, category, location, identifier, notes }) {
    const result = db.prepare(
      `INSERT INTO assets (name, category, location, identifier, notes, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(name, category, location || null, identifier || null, notes || null, nowTaipei());
    return Asset.findById(result.lastInsertRowid);
  },

  update(id, { name, category, location, identifier, notes, is_active }) {
    db.prepare(
      `UPDATE assets SET name = ?, category = ?, location = ?, identifier = ?, notes = ?, is_active = ?
       WHERE id = ?`
    ).run(name, category, location || null, identifier || null, notes || null, is_active ? 1 : 0, id);
    return Asset.findById(id);
  },
};

module.exports = Asset;
