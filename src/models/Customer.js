// 客戶主檔（customers）。設備透過 assets.customer_id 歸屬客戶；巡檢批次涵蓋哪些客戶由它的設備決定。
const db = require('./db');
const { nowTaipei } = require('../utils/time');

const MAX_NAME = 40;
const MAX_CODE = 20;
const MAX_NOTES = 300;

function validate({ name, code, notes }, excludeId = null) {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!n) return { error: '請輸入客戶名稱' };
  if (n.length > MAX_NAME) return { error: `客戶名稱不能超過 ${MAX_NAME} 個字` };
  if (/[\u0000-\u001f<>]/.test(n)) return { error: '客戶名稱含有不允許的字元' };
  const dup = db.prepare('SELECT id FROM customers WHERE name = ?').get(n); // 欄位是 COLLATE NOCASE：不分大小寫比對
  if (dup && dup.id !== excludeId) return { error: '已經有同名的客戶' };
  const c = String(code == null ? '' : code).trim();
  if (c.length > MAX_CODE) return { error: `簡稱／代碼不能超過 ${MAX_CODE} 個字` };
  if (/[\u0000-\u001f<>]/.test(c)) return { error: '簡稱／代碼含有不允許的字元' };
  const note = String(notes == null ? '' : notes).replace(/\r\n/g, '\n').trim();
  if (note.length > MAX_NOTES) return { error: `備註不能超過 ${MAX_NOTES} 個字` };
  return { value: { name: n, code: c || null, notes: note || null } };
}

const Customer = {
  MAX_NAME, MAX_CODE, MAX_NOTES, validate,

  findAll({ activeOnly = false } = {}) {
    return db.prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM assets a WHERE a.customer_id = c.id) AS asset_count
       FROM customers c ${activeOnly ? 'WHERE c.is_active = 1' : ''} ORDER BY c.name COLLATE NOCASE ASC`
    ).all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  },

  findByName(name) {
    return db.prepare('SELECT * FROM customers WHERE name = ?').get(String(name || '').replace(/\s+/g, ' ').trim());
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM customers WHERE is_active = 1').get().n;
  },

  create({ name, code, notes }) {
    const r = db.prepare('INSERT INTO customers (name, code, notes, is_active, created_at) VALUES (?, ?, ?, 1, ?)').run(name, code || null, notes || null, nowTaipei());
    return Customer.findById(r.lastInsertRowid);
  },

  update(id, { name, code, notes }) {
    db.prepare('UPDATE customers SET name = ?, code = ?, notes = ? WHERE id = ?').run(name, code || null, notes || null, id);
  },

  setActive(id, active) {
    db.prepare('UPDATE customers SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },

  // 有設備的客戶只能停用，從沒用過的才能刪
  remove(id) {
    if (db.prepare('SELECT 1 FROM assets WHERE customer_id = ? LIMIT 1').get(id)) return false;
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    return true;
  },

  // 設備可以選的客戶：啟用中的，另外加上這台設備目前正在用的（即使已停用也要保留）
  selectable(alsoInclude = null) {
    return db.prepare('SELECT id, name FROM customers WHERE is_active = 1 OR id = ? ORDER BY name COLLATE NOCASE ASC').all(alsoInclude || 0);
  },

  // 批次設定客戶：一次把一批設備指到某個客戶（customerId 為 null＝清除）。回傳更新台數
  assignAssets(assetIds, customerId) {
    const ids = [...new Set(assetIds.map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const upd = db.prepare('UPDATE assets SET customer_id = ? WHERE id = ?');
    let n = 0;
    db.transaction(() => { for (const id of ids) n += upd.run(customerId || null, id).changes; })();
    return n;
  },
};

module.exports = Customer;
