const crypto = require('crypto');
const db = require('./db');

const MAX_LABEL = 40;

function validateLabel(category, label, excludeId = null) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return '請輸入檢查項目名稱';
  if (text.length > MAX_LABEL) return `檢查項目名稱不能超過 ${MAX_LABEL} 個字`;
  if (/[\u0000-\u001f<>]/.test(text)) return '檢查項目名稱含有不允許的字元';
  const dup = db.prepare('SELECT id FROM checklist_items WHERE category = ? AND lower(label) = lower(?)').get(category, text);
  if (dup && dup.id !== excludeId) return '這個類型已經有同名的檢查項目';
  return null;
}

function newCode(category) {
  for (;;) {
    const code = `item_${crypto.randomBytes(4).toString('hex')}`;
    if (!db.prepare('SELECT 1 FROM checklist_items WHERE category = ? AND code = ?').get(category, code)) return code;
  }
}

const ChecklistItem = {
  MAX_LABEL,
  validateLabel,

  // includeInactive：管理頁要看全部；一般填寫頁只要啟用中的
  // （但已經有紀錄的停用項目，填寫頁仍要顯示，見 routes/batches.js 的 buildEntryData）
  findByCategory(category, { includeInactive = false } = {}) {
    return db.prepare(
      `SELECT * FROM checklist_items WHERE category = ? ${includeInactive ? '' : 'AND is_active = 1'}
       ORDER BY sort_order ASC, id ASC`
    ).all(category);
  },

  findById(id) {
    return db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(id);
  },

  findAll() {
    return db.prepare('SELECT * FROM checklist_items ORDER BY category ASC, sort_order ASC').all();
  },

  create(category, label) {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM checklist_items WHERE category = ?').get(category).n;
    const result = db.prepare(
      'INSERT INTO checklist_items (category, code, label, sort_order, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(category, newCode(category), label.trim(), next);
    return ChecklistItem.findById(result.lastInsertRowid);
  },

  rename(id, label) {
    db.prepare('UPDATE checklist_items SET label = ? WHERE id = ?').run(label.trim(), id);
  },

  setActive(id, active) {
    db.prepare('UPDATE checklist_items SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },

  move(id, direction) {
    const item = ChecklistItem.findById(id);
    if (!item) return false;
    const list = ChecklistItem.findByCategory(item.category, { includeInactive: true });
    const i = list.findIndex(c => c.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const tx = db.transaction(() => {
      const ids = list.map(c => c.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const upd = db.prepare('UPDATE checklist_items SET sort_order = ? WHERE id = ?');
      ids.forEach((cid, idx) => upd.run(idx + 1, cid));
    });
    tx();
    return true;
  },

  recordCount(id) {
    return db.prepare('SELECT COUNT(*) AS n FROM inspection_items WHERE checklist_item_id = ?').get(id).n;
  },

  // 用過（有任何檢查紀錄）的項目只能停用，從沒用過的才能刪除
  remove(id) {
    if (ChecklistItem.recordCount(id) > 0) return false;
    db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
    return true;
  },

  // 把來源類型「啟用中」的項目複製到目標類型（目標已有同名的就跳過），回傳新增了幾筆
  copyAll(fromCategory, toCategory) {
    const existing = new Set(
      ChecklistItem.findByCategory(toCategory, { includeInactive: true }).map(i => i.label.toLowerCase())
    );
    let added = 0;
    for (const item of ChecklistItem.findByCategory(fromCategory)) {
      if (existing.has(item.label.toLowerCase())) continue;
      ChecklistItem.create(toCategory, item.label);
      added++;
    }
    return added;
  },
};

module.exports = ChecklistItem;
