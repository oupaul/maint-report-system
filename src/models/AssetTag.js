// 資產標籤（asset_tags / asset_tag_links）。標籤名稱不分大小寫唯一；標籤是自由輸入的（逗號分隔），
// 不存在就自動建立，沒有設備在用就自動清掉，所以不需要另外的標籤管理頁。
const db = require('./db');
const { nowTaipei } = require('../utils/time');

const MAX_TAG_LEN = 20;
const MAX_PER_ASSET = 10;

const AssetTag = {
  MAX_TAG_LEN,
  MAX_PER_ASSET,

  // 把輸入（逗號、頓號、分號、換行分隔）整理成標籤陣列；回傳 { tags, error }
  parse(input) {
    const tags = [];
    for (const raw of String(input || '').split(/[,，、;；\n\r]+/)) {
      const t = raw.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      if (t.length > MAX_TAG_LEN) return { tags, error: `標籤「${t.slice(0, 12)}…」太長了（每個最多 ${MAX_TAG_LEN} 個字）` };
      if (/[\u0000-\u001f<>]/.test(t)) return { tags, error: '標籤含有不允許的字元' };
      if (tags.some(x => x.toLowerCase() === t.toLowerCase())) continue;
      tags.push(t);
    }
    if (tags.length > MAX_PER_ASSET) return { tags, error: `一台設備最多 ${MAX_PER_ASSET} 個標籤` };
    return { tags, error: null };
  },

  // 設定某台設備的標籤（整組取代）。呼叫端要放在同一個交易裡
  setForAsset(assetId, names) {
    const findTag = db.prepare('SELECT id FROM asset_tags WHERE name = ?');
    const insTag = db.prepare('INSERT INTO asset_tags (name, created_at) VALUES (?, ?)');
    const ids = names.map(n => {
      const row = findTag.get(n);
      return row ? row.id : insTag.run(n, nowTaipei()).lastInsertRowid;
    });
    db.prepare('DELETE FROM asset_tag_links WHERE asset_id = ?').run(assetId);
    const link = db.prepare('INSERT OR IGNORE INTO asset_tag_links (asset_id, tag_id) VALUES (?, ?)');
    ids.forEach(id => link.run(assetId, id));
    db.prepare('DELETE FROM asset_tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM asset_tag_links)').run();
  },

  // 在設備陣列上補 tags（名稱陣列，依名稱排序）
  attach(assets) {
    if (!assets || assets.length === 0) return assets;
    const byAsset = new Map();
    const rows = db.prepare(
      `SELECT l.asset_id, t.name FROM asset_tag_links l JOIN asset_tags t ON t.id = l.tag_id ORDER BY t.name COLLATE NOCASE ASC`
    ).all();
    for (const r of rows) {
      if (!byAsset.has(r.asset_id)) byAsset.set(r.asset_id, []);
      byAsset.get(r.asset_id).push(r.name);
    }
    for (const a of assets) a.tags = byAsset.get(a.id) || [];
    return assets;
  },

  // 目前有設備在用的標籤與台數（篩選下拉選單、編輯頁的「現有標籤」用）
  inUse() {
    return db.prepare(
      `SELECT t.name, COUNT(*) AS count FROM asset_tags t JOIN asset_tag_links l ON l.tag_id = t.id
       GROUP BY t.id ORDER BY t.name COLLATE NOCASE ASC`
    ).all();
  },
};

module.exports = AssetTag;
