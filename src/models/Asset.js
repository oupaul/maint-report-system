const db = require('./db');
const { nowTaipei } = require('../utils/time');

const SEARCH_COLUMNS = ['name', 'location', 'ip_address', 'mac_address', 'hostname', 'serial_number', 'asset_tag', 'brand', 'model', 'purchase_date', 'identifier'];

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

  // 資產管理頁的搜尋／篩選：q 以空白分隔多個關鍵字（全部都要符合），比對名稱、位置、IP、主機名稱、序號、財產編號、舊識別碼
  search({ q = '', category = '' } = {}) {
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
      where.push(`(${conds.join(' OR ')})`);
    });
    if (category) { where.push('a.category = ?'); params.push(category); }
    return db.prepare(
      `SELECT a.* FROM assets a LEFT JOIN asset_categories ac ON ac.code = a.category
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ac.sort_order ASC, a.category ASC, a.name ASC`
    ).all(...params);
  },

  create({ name, category, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, notes }) {
    const result = db.prepare(
      `INSERT INTO assets (name, category, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, notes, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(name, category, location || null, ip_address || null, mac_address || null, hostname || null, serial_number || null,
      asset_tag || null, brand || null, model || null, purchase_date || null, notes || null, nowTaipei());
    return Asset.findById(result.lastInsertRowid);
  },

  // identifier 是舊的「識別碼」欄位（待整理用，只能保留或清空，不再新增內容）
  update(id, { name, category, location, ip_address, mac_address, hostname, serial_number, asset_tag, brand, model, purchase_date, identifier, notes, is_active }) {
    db.prepare(
      `UPDATE assets SET name = ?, category = ?, location = ?, ip_address = ?, mac_address = ?, hostname = ?, serial_number = ?,
         asset_tag = ?, brand = ?, model = ?, purchase_date = ?, identifier = ?, notes = ?, is_active = ?
       WHERE id = ?`
    ).run(name, category, location || null, ip_address || null, mac_address || null, hostname || null, serial_number || null,
      asset_tag || null, brand || null, model || null, purchase_date || null, identifier || null, notes || null, is_active ? 1 : 0, id);
    return Asset.findById(id);
  },
};

module.exports = Asset;
