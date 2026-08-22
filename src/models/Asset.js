const db = require('./db');

const Asset = {
  findById(id) {
    return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  },

  findAll({ includeInactive = false } = {}) {
    if (includeInactive) {
      return db.prepare('SELECT * FROM assets ORDER BY category ASC, name ASC').all();
    }
    return db.prepare('SELECT * FROM assets WHERE is_active = 1 ORDER BY category ASC, name ASC').all();
  },

  findByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...ids);
  },

  create({ name, category, location, identifier, notes }) {
    const result = db.prepare(
      `INSERT INTO assets (name, category, location, identifier, notes, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`
    ).run(name, category, location || null, identifier || null, notes || null);
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
