const crypto = require('crypto');
const db = require('./db');
const ChecklistItem = require('./ChecklistItem');

const MAX_LABEL = 30;

// 類型的「代碼」建立後不可改（資產與檢查項目都用代碼關聯），只有顯示名稱能改。
// 內建的 pc / server / nas / network_device 保留原本的代碼；新增的類型自動產生代碼，
// 管理者只需要填名稱，不用（也不該）關心代碼。
function generateCode() {
  for (;;) {
    const code = `cat_${crypto.randomBytes(4).toString('hex')}`;
    if (!AssetCategory.findByCode(code)) return code;
  }
}

function validateLabel(label, excludeId = null) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return '請輸入類型名稱';
  if (text.length > MAX_LABEL) return `類型名稱不能超過 ${MAX_LABEL} 個字`;
  if (/[\u0000-\u001f<>]/.test(text)) return '類型名稱含有不允許的字元';
  const dup = db.prepare('SELECT id FROM asset_categories WHERE lower(label) = lower(?)').get(text);
  if (dup && dup.id !== excludeId) return '已經有同名的類型';
  return null;
}

const AssetCategory = {
  MAX_LABEL,
  validateLabel,

  findAll({ activeOnly = false } = {}) {
    return db.prepare(
      `SELECT * FROM asset_categories ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`
    ).all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM asset_categories WHERE id = ?').get(id);
  },

  findByCode(code) {
    return db.prepare('SELECT * FROM asset_categories WHERE code = ?').get(code);
  },

  // 代碼 → 顯示名稱（含已停用的類型：舊資產、舊報告仍要顯示得出名稱）
  labelMap() {
    const map = {};
    for (const c of AssetCategory.findAll()) map[c.code] = c.label;
    return map;
  },

  // 新增資產/批次時可以選的類型（只有啟用中的）
  isSelectable(code) {
    const c = AssetCategory.findByCode(code);
    return !!(c && c.is_active);
  },

  // 給畫面下拉選單用：啟用中的類型代碼，另外可帶入某個「目前已經在用、即使已停用也要保留」的代碼
  selectableCodes(alsoInclude = null) {
    const codes = AssetCategory.findAll({ activeOnly: true }).map(c => c.code);
    if (alsoInclude && !codes.includes(alsoInclude) && AssetCategory.findByCode(alsoInclude)) codes.push(alsoInclude);
    return codes;
  },

  create(label, { copyFromCode = null } = {}) {
    const text = label.trim();
    const code = generateCode();
    const next = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM asset_categories').get().n);
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO asset_categories (code, label, sort_order) VALUES (?, ?, ?)').run(code, text, next);
      if (copyFromCode) ChecklistItem.copyAll(copyFromCode, code);
    });
    tx();
    return AssetCategory.findByCode(code);
  },

  rename(id, label) {
    db.prepare('UPDATE asset_categories SET label = ? WHERE id = ?').run(label.trim(), id);
  },

  setActive(id, active) {
    db.prepare('UPDATE asset_categories SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },

  // 跟上一個／下一個交換排序
  move(id, direction) {
    const list = AssetCategory.findAll();
    const i = list.findIndex(c => c.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const tx = db.transaction(() => {
      // 用整個清單重新編號，避免兩筆排序值剛好相同時交換沒有效果
      const ids = list.map(c => c.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const upd = db.prepare('UPDATE asset_categories SET sort_order = ? WHERE id = ?');
      ids.forEach((cid, idx) => upd.run(idx + 1, cid));
    });
    tx();
    return true;
  },

  usage(category) {
    const assets = db.prepare('SELECT COUNT(*) AS n FROM assets WHERE category = ?').get(category.code).n;
    const checklist = db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE category = ? AND is_active = 1').get(category.code).n;
    const checklistAll = db.prepare('SELECT COUNT(*) AS n FROM checklist_items WHERE category = ?').get(category.code).n;
    const records = db.prepare(
      `SELECT COUNT(*) AS n FROM inspection_items ii
       JOIN checklist_items ci ON ci.id = ii.checklist_item_id WHERE ci.category = ?`
    ).get(category.code).n;
    return { assets, checklist, checklistAll, records };
  },

  // 只有「沒有任何設備、也沒有任何檢查紀錄」的類型才能刪除；其餘只能停用，
  // 這樣舊資料與舊報告永遠不會對不到類型或項目。
  canDelete(category) {
    const u = AssetCategory.usage(category);
    return u.assets === 0 && u.records === 0;
  },

  remove(id) {
    const category = AssetCategory.findById(id);
    if (!category || !AssetCategory.canDelete(category)) return false;
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM checklist_items WHERE category = ?').run(category.code);
      db.prepare('DELETE FROM asset_categories WHERE id = ?').run(id);
    });
    tx();
    return true;
  },
};

module.exports = AssetCategory;
