const db = require('./db');
const { nowTaipei } = require('../utils/time');
const AssetField = require('./AssetField');
const AssetTag = require('./AssetTag');

// 取回設備後補上自訂欄位的值、標籤與客戶名稱（所有對外回傳設備的方法都要經過這裡）
function enrich(rows) {
  AssetField.attach(rows);
  AssetTag.attach(rows);
  if (rows.some(r => r.customer_id)) {
    const cs = new Map(db.prepare('SELECT id, name, tax_id FROM customers').all().map(c => [c.id, c]));
    rows.forEach(r => {
      const c = r.customer_id ? cs.get(r.customer_id) : null;
      r.customer_name = c ? c.name : null;
      r.customer_tax_id = c ? c.tax_id : null;
    });
  } else {
    rows.forEach(r => { r.customer_name = null; r.customer_tax_id = null; });
  }
  return rows;
}

// 列表可排序的欄位（key 是網址參數；值是 SQL 的排序欄位，nullsLast＝空值排最後）
const SORT_COLUMNS = (() => {
  const text = (...cols) => Object.assign(cols.map(c => `a.${c}`), { nullsLast: true });
  return {
    category: Object.assign(['ac.sort_order', 'a.category'], { nullsLast: false }),
    customer: Object.assign(['cu.name'], { nullsLast: true }),
    name: Object.assign(['a.name'], { nullsLast: false }),
    location: text('location'),
    ip_address: text('ip_address'),
    hostname: text('hostname'),
    brand: text('brand', 'model'),
    serial_number: text('serial_number'),
    asset_tag: text('asset_tag'),
    purchase_date: text('purchase_date'),
    is_active: Object.assign(['a.is_active'], { nullsLast: false }),
  };
})();

// 客戶名稱另外在 query() 用 JOIN 的 cu.name 搜尋
const SEARCH_COLUMNS = ['name', 'location', 'ip_address', 'mac_address', 'hostname', 'serial_number', 'asset_tag', 'brand', 'model', 'purchase_date', 'identifier'];

const Asset = {
  findById(id) {
    const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    return a ? enrich([a])[0] : a;
  },

  // 依類型管理頁設定的排序顯示（類型排序 → 名稱）
  findAll({ includeInactive = false } = {}) {
    const rows = db.prepare(
      `SELECT a.* FROM assets a LEFT JOIN asset_categories ac ON ac.code = a.category
       ${includeInactive ? '' : 'WHERE a.is_active = 1'}
       ORDER BY ac.sort_order ASC, a.category ASC, a.name ASC`
    ).all();
    return enrich(rows);
  },

  // 已經有檢查紀錄的資產不能改類型：舊紀錄是對應「原本類型」的檢查項目，改了類型就對不上
  hasRecords(id) {
    return !!db.prepare('SELECT 1 FROM inspection_items WHERE asset_id = ? LIMIT 1').get(id);
  },

  findByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return enrich(db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...ids));
  },

  // 資產管理頁用：搜尋、篩選、排序、分頁。
  // q 以空白分隔多個關鍵字（全部都要符合），比對名稱、位置、IP、MAC、主機名稱、序號、財產編號、廠牌、型號、購置日期、
  // 舊識別碼、標籤與啟用中自訂欄位的值。
  // 回傳 { rows, total, groupCounts }：total＝符合條件的總數（分頁前）、groupCounts＝各類別的符合台數（分組標題用）。
  query({ q = '', category = '', location = '', status = '', tag = '', sort = 'category', dir = 'asc', customer = '', grouped = true, page = 1, per = 50, all = false } = {}) {
    const where = [];
    const params = [];
    String(q).trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8).forEach(token => {
      const like = `%${token.replace(/[\\%_]/g, m => '\\' + m)}%`;
      const conds = SEARCH_COLUMNS.map(c => `LOWER(COALESCE(a.${c}, '')) LIKE ? ESCAPE '\\'`);
      SEARCH_COLUMNS.forEach(() => params.push(like));
      // MAC 常不帶冒號搜尋（aabbcc）：另外比對拿掉分隔符號後的內容
      const bare = token.replace(/[:\-.]/g, '');
      if (bare.length >= 4 && /^[0-9a-f]+$/.test(bare)) {
        conds.push(`LOWER(REPLACE(COALESCE(a.mac_address, ''), ':', '')) LIKE ?`);
        params.push(`%${bare}%`);
      }
      // 自訂欄位的值（只搜啟用中的、非「是／否」的欄位）
      conds.push(`EXISTS (SELECT 1 FROM asset_field_values v JOIN asset_field_defs d ON d.id = v.field_id
        WHERE v.asset_id = a.id AND d.is_active = 1 AND d.type <> 'boolean' AND LOWER(v.value) LIKE ? ESCAPE '\\')`);
      params.push(like);
      // 客戶名稱
      conds.push(`LOWER(COALESCE(cu.name, '')) LIKE ? ESCAPE '\\'`);
      params.push(like);
      // 標籤
      conds.push(`EXISTS (SELECT 1 FROM asset_tag_links l JOIN asset_tags t ON t.id = l.tag_id
        WHERE l.asset_id = a.id AND LOWER(t.name) LIKE ? ESCAPE '\\')`);
      params.push(like);
      where.push(`(${conds.join(' OR ')})`);
    });
    if (category) { where.push('a.category = ?'); params.push(category); }
    if (location) { where.push('a.location = ?'); params.push(location); }
    if (customer === 'none') where.push('a.customer_id IS NULL');
    else if (customer) { where.push('a.customer_id = ?'); params.push(Number(customer) || 0); }
    if (status === '1' || status === '0') { where.push('a.is_active = ?'); params.push(Number(status)); }
    if (tag) {
      where.push('EXISTS (SELECT 1 FROM asset_tag_links l JOIN asset_tags t ON t.id = l.tag_id WHERE l.asset_id = a.id AND t.name = ?)');
      params.push(tag);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = 'FROM assets a LEFT JOIN asset_categories ac ON ac.code = a.category LEFT JOIN customers cu ON cu.id = a.customer_id';

    // 排序：欄位只能是白名單裡的（不把使用者輸入拼進 SQL）；空值一律排最後
    const col = Object.prototype.hasOwnProperty.call(SORT_COLUMNS, sort) ? SORT_COLUMNS[sort] : SORT_COLUMNS.category;
    const d = dir === 'desc' ? 'DESC' : 'ASC';
    const orderBy = [];
    if (grouped && sort !== 'category') orderBy.push('ac.sort_order ASC', 'a.category ASC'); // 分組顯示時，類別永遠是第一層
    col.forEach(c => {
      if (col.nullsLast) orderBy.push(`(${c} IS NULL OR ${c} = '') ASC`);
      orderBy.push(`${c} ${d}`);
    });
    orderBy.push('a.name ASC', 'a.id ASC');

    const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).get(...params).n;
    const groupCounts = {};
    db.prepare(`SELECT a.category AS c, COUNT(*) AS n ${from} ${whereSql} GROUP BY a.category`).all(...params).forEach(r => { groupCounts[r.c] = r.n; });
    const pageSize = Math.min(Math.max(parseInt(per, 10) || 50, 10), 200);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const current = Math.min(Math.max(parseInt(page, 10) || 1, 1), pages);
    // all：匯出用，不分頁
    const rows = all
      ? db.prepare(`SELECT a.* ${from} ${whereSql} ORDER BY ${orderBy.join(', ')}`).all(...params)
      : db.prepare(`SELECT a.* ${from} ${whereSql} ORDER BY ${orderBy.join(', ')} LIMIT ? OFFSET ?`).all(...params, pageSize, (current - 1) * pageSize);
    return { rows: enrich(rows), total, groupCounts, page: current, pages, pageSize };
  },

  countActive() {
    return db.prepare('SELECT COUNT(*) AS n FROM assets WHERE is_active = 1').get().n;
  },

  setActive(id, active) {
    db.prepare('UPDATE assets SET is_active = ? WHERE id = ?').run(active ? 1 : 0, id);
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
  },

  // 資料庫裡出現過的位置（去重、排序），給位置下拉篩選與編輯頁的自動完成用
  locations() {
    return db.prepare("SELECT DISTINCT TRIM(location) AS l FROM assets WHERE location IS NOT NULL AND TRIM(location) <> '' ORDER BY l COLLATE NOCASE ASC")
      .all().map(r => r.l);
  },

  // custom：AssetField.parse 的結果（{欄位id: 值或 null}），和資產本身放在同一個交易裡寫入
  create({ name, category, customer_id, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, notes, custom, tags }) {
    const id = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO assets (name, category, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, notes, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      ).run(name, category, location || null, ip_address || null, mac_address || null, hostname || null, serial_number || null,
        asset_tag || null, brand || null, model || null, purchase_date || null, notes || null, nowTaipei());
      if (customer_id) db.prepare('UPDATE assets SET customer_id = ? WHERE id = ?').run(customer_id, result.lastInsertRowid);
      if (custom) AssetField.saveValues(result.lastInsertRowid, custom);
      if (tags) AssetTag.setForAsset(result.lastInsertRowid, tags);
      return result.lastInsertRowid;
    })();
    return Asset.findById(id);
  },

  // identifier 是舊的「識別碼」欄位（待整理用，只能保留或清空，不再新增內容）
  update(id, { name, category, customer_id, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, identifier, notes, is_active, custom, tags }) {
    db.transaction(() => {
      db.prepare(
        `UPDATE assets SET name = ?, category = ?, location = ?, ip_address = ?, mac_address = ?, hostname = ?, serial_number = ?,
           asset_tag = ?, brand = ?, model = ?, purchase_date = ?, identifier = ?, notes = ?, is_active = ?
         WHERE id = ?`
      ).run(name, category, location || null, ip_address || null, mac_address || null, hostname || null, serial_number || null,
        asset_tag || null, brand || null, model || null, purchase_date || null, identifier || null, notes || null, is_active ? 1 : 0, id);
      // customer_id：undefined＝不動（例如 CSV 沒有客戶欄），null＝清除，數字＝指定
      if (customer_id !== undefined) db.prepare('UPDATE assets SET customer_id = ? WHERE id = ?').run(customer_id || null, id);
      if (custom) AssetField.saveValues(id, custom);
      if (tags) AssetTag.setForAsset(id, tags);
    })();
    return Asset.findById(id);
  },
};

module.exports = Asset;
