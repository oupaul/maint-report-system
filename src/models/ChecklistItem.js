const db = require('./db');

const ChecklistItem = {
  findByCategory(category) {
    return db.prepare(
      'SELECT * FROM checklist_items WHERE category = ? ORDER BY sort_order ASC'
    ).all(category);
  },

  findById(id) {
    return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  },

  findAll() {
    return db.prepare('SELECT * FROM checklist_items ORDER BY category ASC, sort_order ASC').all();
  },
};

module.exports = ChecklistItem;
