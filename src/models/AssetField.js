// 管理員自訂的資產欄位。定義在 asset_field_defs、每台設備的值在 asset_field_values（只存有填的值，值一律是文字）。
// 規則（比照設備類型）：用過的欄位只能停用、不能刪除；沒有任何值的欄位才能改資料類型或刪除。
const db = require('./db');
const { nowTaipei } = require('../utils/time');

const TYPES = {
  text: '文字',
  number: '數字',
  date: '日期',
  select: '下拉選單',
  boolean: '是／否',
};
const MAX_LABEL = 30;
const MAX_FIELDS = 30;
const MAX_OPTIONS = 50;
const MAX_OPTION_LEN = 50;
const MAX_TEXT = 200;
// 固定欄位的名稱不能拿來當自訂欄位名稱，避免畫面上出現兩個同名的欄位
const RESERVED_LABELS = ['名稱', '資產名稱', '類別', '位置', '備註', '狀態', 'ip 位址', 'ip', 'mac 位址', 'mac', '主機名稱', '序號', '財產編號', '廠牌', '型號', '購置日期', '舊識別碼', '識別碼'];

function parseJsonArray(text) {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function hydrate(row) {
  if (!row) return row;
  return { ...row, optionList: parseJsonArray(row.options) || [], categoryList: parseJsonArray(row.category_codes) };
}

function appliesTo(def, category) {
  return !def.categoryList || def.categoryList.length === 0 || def.categoryList.includes(category);
}

function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

// 把顯示用的文字做出來（列表、報告、挑選器共用）
function formatValue(def, value) {
  if (value == null || value === '') return '';
  if (def.type === 'boolean') return value === '1' ? '是' : '否';
  return String(value);
}

const AssetField = {
  TYPES,
  MAX_LABEL,
  MAX_FIELDS,
  MAX_OPTIONS,
  MAX_OPTION_LEN,
  MAX_TEXT,
  appliesTo,
  formatValue,

  findAll({ activeOnly = false } = {}) {
    return db.prepare(`SELECT * FROM asset_field_defs ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order ASC, id ASC`).all().map(hydrate);
  },

  findById(id) {
    return hydrate(db.prepare('SELECT * FROM asset_field_defs WHERE id = ?').get(id));
  },

  valueCount(id) {
    return db.prepare('SELECT COUNT(*) AS n FROM asset_field_values WHERE field_id = ?').get(id).n;
  },

  isUsed(id) {
    return AssetField.valueCount(id) > 0;
  },

  validateLabel(label, excludeId = null) {
    const text = typeof label === 'string' ? label.trim() : '';
    if (!text) return '請輸入欄位名稱';
    if (text.length > MAX_LABEL) return `欄位名稱不能超過 ${MAX_LABEL} 個字`;
    if (/[\u0000-\u001f<>]/.test(text)) return '欄位名稱含有不允許的字元';
    if (RESERVED_LABELS.includes(text.toLowerCase())) return '這個名稱已經是系統內建的欄位，請換一個名稱';
    const dup = db.prepare('SELECT id FROM asset_field_defs WHERE lower(label) = lower(?)').get(text);
    if (dup && dup.id !== excludeId) return '已經有同名的欄位';
    return null;
  },

  // 下拉選項：一行一個。回傳 { list, error }
  parseOptions(text) {
    const list = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
      const v = raw.trim();
      if (!v) continue;
      if (v.length > MAX_OPTION_LEN) return { list, error: `每個選項不能超過 ${MAX_OPTION_LEN} 個字` };
      if (/[\u0000-\u001f<>]/.test(v)) return { list, error: '選項含有不允許的字元' };
      if (list.some(x => x.toLowerCase() === v.toLowerCase())) continue;
      list.push(v);
    }
    if (list.length === 0) return { list, error: '下拉選單至少要有一個選項（一行一個）' };
    if (list.length > MAX_OPTIONS) return { list, error: `選項最多 ${MAX_OPTIONS} 個` };
    return { list, error: null };
  },

  // categoryCodes：勾選的類別代碼陣列；全選或全不選都當作「所有類別」
  normalizeCategories(codes, allCodes) {
    const picked = (Array.isArray(codes) ? codes : (codes ? [codes] : [])).filter(c => allCodes.includes(c));
    return picked.length === 0 || picked.length === allCodes.length ? null : picked;
  },

  create({ label, type, options, categoryCodes, showInList }) {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM asset_field_defs').get().m;
    const r = db.prepare(
      `INSERT INTO asset_field_defs (label, type, options, category_codes, show_in_list, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(label.trim(), type, type === 'select' ? JSON.stringify(options) : null,
      categoryCodes ? JSON.stringify(categoryCodes) : null, showInList ? 1 : 0, max + 1, nowTaipei());
    return AssetField.findById(r.lastInsertRowid);
  },

  // type 只有在還沒有任何值時才會被改（呼叫端負責檢查）
  update(id, { label, type, options, categoryCodes, showInList }) {
    db.prepare(
      'UPDATE asset_field_defs SET label = ?, type = ?, options = ?, category_codes = ?, show_in_list = ? WHERE id = ?'
    ).run(label.trim(), type, type === 'select' ? JSON.stringify(options) : null,
      categoryCodes ? JSON.stringify(categoryCodes) : null, showInList ? 1 : 0, id);
  },

  setActive(id, active) {
    db.prepare('UPDATE asset_field_defs SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },

  remove(id) {
    if (AssetField.isUsed(id)) return false;
    db.prepare('DELETE FROM asset_field_defs WHERE id = ?').run(id);
    return true;
  },

  move(id, direction) {
    const list = AssetField.findAll();
    const i = list.findIndex(f => f.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= list.length) return false;
    const ids = list.map(f => f.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    db.transaction(() => {
      const upd = db.prepare('UPDATE asset_field_defs SET sort_order = ? WHERE id = ?');
      ids.forEach((fid, idx) => upd.run(idx + 1, fid));
    })();
    return true;
  },

  // ---- 設備的值 ----

  // 在設備陣列上補 custom（{ 欄位id: 值 }，只含啟用中欄位）、customDisplay（列表／報告用，依欄位排序，只含適用且有值的）、
  // customSearch（給挑選器搜尋用的文字）。回傳同一個陣列。
  attach(assets) {
    if (!assets || assets.length === 0) return assets;
    const defs = AssetField.findAll({ activeOnly: true });
    const byAsset = new Map();
    if (defs.length > 0) {
      const ids = defs.map(d => d.id);
      const rows = db.prepare(`SELECT asset_id, field_id, value FROM asset_field_values WHERE field_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      for (const r of rows) {
        if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, {});
        byAsset.get(r.asset_id)[r.field_id] = r.value;
      }
    }
    for (const a of assets) {
      const custom = byAsset.get(a.id) || {};
      a.custom = custom;
      a.customDisplay = defs
        .filter(d => appliesTo(d, a.category) && custom[d.id] != null && custom[d.id] !== '')
        .map(d => ({ id: d.id, label: d.label, type: d.type, text: formatValue(d, custom[d.id]) }));
      a.customSearch = a.customDisplay.filter(x => x.type !== 'boolean').map(x => x.text).join(' ');
    }
    return assets;
  },

  // 編輯頁用：所有啟用中的欄位（連同目前的值），以及是否適用目前選的類別。
  // 即使欄位已停用，只要這台設備有值也不顯示（停用就是從畫面上拿掉）。
  formFields(asset, category) {
    const values = {};
    if (asset && asset.id) {
      for (const r of db.prepare('SELECT field_id, value FROM asset_field_values WHERE asset_id = ?').all(asset.id)) values[r.field_id] = r.value;
    }
    return AssetField.findAll({ activeOnly: true }).map(d => ({
      ...d,
      value: asset && asset.custom_input && asset.custom_input[d.id] !== undefined ? asset.custom_input[d.id] : (values[d.id] == null ? '' : values[d.id]),
      applies: appliesTo(d, category),
    }));
  },

  // 驗證表單送來的自訂欄位值（欄位名稱 cf_<id>）。只處理「啟用中、適用這個類別、而且有送出」的欄位；
  // 沒送出的（例如沒有 JavaScript 時被隱藏的）保持原值。回傳 { values: {id: 值或 null}, error }
  parse(body, category, currentValues = {}) {
    const values = {};
    for (const d of AssetField.findAll({ activeOnly: true })) {
      if (!appliesTo(d, category)) continue;
      const name = `cf_${d.id}`;
      if (!Object.prototype.hasOwnProperty.call(body, name)) continue;
      const v = String(body[name] == null ? '' : body[name]).trim();
      if (v === '') { values[d.id] = null; continue; }
      const bad = (msg) => ({ values, error: `「${d.label}」${msg}` });
      if (d.type === 'text') {
        if (v.length > MAX_TEXT) return bad(`太長了（最多 ${MAX_TEXT} 個字）`);
        values[d.id] = v;
      } else if (d.type === 'number') {
        if (!/^-?\d+(\.\d+)?$/.test(v) || v.length > 20) return bad('請輸入數字（例如 16 或 3.5）');
        values[d.id] = v;
      } else if (d.type === 'date') {
        if (!isRealDate(v)) return bad('日期格式不正確，請用 年-月-日（例如 2025-06-30）');
        values[d.id] = v;
      } else if (d.type === 'select') {
        // 選項後來被拿掉、但這台設備原本就是這個值：允許原樣保留
        if (!d.optionList.includes(v) && currentValues[d.id] !== v) return bad('不是有效的選項');
        values[d.id] = v;
      } else if (d.type === 'boolean') {
        if (v !== '1' && v !== '0') return bad('請選擇「是」或「否」');
        values[d.id] = v;
      }
    }
    return { values, error: null };
  },

  currentValues(assetId) {
    const out = {};
    for (const r of db.prepare('SELECT field_id, value FROM asset_field_values WHERE asset_id = ?').all(assetId)) out[r.field_id] = r.value;
    return out;
  },

  // 寫入 parse 的結果（null = 清空）。呼叫端要放在同一個交易裡
  saveValues(assetId, values) {
    const del = db.prepare('DELETE FROM asset_field_values WHERE asset_id = ? AND field_id = ?');
    const up = db.prepare(
      'INSERT INTO asset_field_values (asset_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT(asset_id, field_id) DO UPDATE SET value = excluded.value'
    );
    for (const [fid, v] of Object.entries(values)) {
      if (v == null) del.run(assetId, fid); else up.run(assetId, fid, v);
    }
  },
};

module.exports = AssetField;
