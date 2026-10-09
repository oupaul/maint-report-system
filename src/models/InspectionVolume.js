// 容量型檢查項目的磁碟區紀錄（inspection_item_volumes）。容量一律存 GB。
const db = require('./db');
const capacity = require('../utils/capacity');

const InspectionVolume = {
  // 整組取代某個檢查紀錄的磁碟區（呼叫端放在交易裡）
  replaceForItem(itemId, volumes) {
    db.prepare('DELETE FROM inspection_item_volumes WHERE inspection_item_id = ?').run(itemId);
    const ins = db.prepare(
      'INSERT INTO inspection_item_volumes (inspection_item_id, name, used_gb, total_gb, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    volumes.forEach((v, i) => ins.run(itemId, v.name, v.used_gb, v.total_gb, i));
  },

  findByItemId(itemId) {
    return db.prepare('SELECT * FROM inspection_item_volumes WHERE inspection_item_id = ? ORDER BY sort_order ASC, id ASC').all(itemId);
  },

  // 在檢查紀錄陣列上補 volumes（沒有的是空陣列）
  attach(items) {
    if (!items || items.length === 0) return items;
    const map = new Map();
    const ids = items.map(i => i.id);
    for (let off = 0; off < ids.length; off += 500) {
      const chunk = ids.slice(off, off + 500);
      const rows = db.prepare(
        `SELECT * FROM inspection_item_volumes WHERE inspection_item_id IN (${chunk.map(() => '?').join(',')}) ORDER BY sort_order ASC, id ASC`
      ).all(...chunk);
      rows.forEach(r => {
        if (!map.has(r.inspection_item_id)) map.set(r.inspection_item_id, []);
        map.get(r.inspection_item_id).push(r);
      });
    }
    items.forEach(i => { i.volumes = map.get(i.id) || []; });
    return items;
  },

  // 這個設備這個項目「上一次」（別的批次、日期最近）記錄的磁碟區：新增巡檢時自動帶入名稱與總容量
  previousFor(assetId, checklistItemId, excludeBatchId) {
    const prev = db.prepare(
      `SELECT ii.id FROM inspection_items ii
       JOIN inspection_batches b ON b.id = ii.batch_id
       WHERE ii.asset_id = ? AND ii.checklist_item_id = ? AND ii.batch_id <> ?
         AND EXISTS (SELECT 1 FROM inspection_item_volumes v WHERE v.inspection_item_id = ii.id)
       ORDER BY b.batch_date DESC, ii.batch_id DESC LIMIT 1`
    ).get(assetId, checklistItemId, excludeBatchId);
    return prev ? InspectionVolume.findByItemId(prev.id) : [];
  },

  // 某台設備所有磁碟區的歷史（趨勢頁用）：依日期排序；同一天同一磁碟區若有多筆（不同批次）都保留
  seriesForAsset(assetId) {
    return db.prepare(
      `SELECT v.name, v.used_gb, v.total_gb, b.batch_date AS date, b.id AS batch_id, b.title AS batch_title,
              ii.checklist_item_id, COALESCE(ii.item_label, ci.label) AS item_label, ci.warn_pct, ci.crit_pct
       FROM inspection_item_volumes v
       JOIN inspection_items ii ON ii.id = v.inspection_item_id
       JOIN inspection_batches b ON b.id = ii.batch_id
       JOIN checklist_items ci ON ci.id = ii.checklist_item_id
       WHERE ii.asset_id = ?
       ORDER BY b.batch_date ASC, b.id ASC, v.sort_order ASC`
    ).all(assetId);
  },

  // 全部設備的資料（容量預警與 CSV 匯出用）
  allRows() {
    return db.prepare(
      `SELECT a.id AS asset_id, a.name AS asset_name, a.category, a.location, a.is_active,
              v.name AS volume, v.used_gb, v.total_gb, b.batch_date AS date, b.id AS batch_id, b.title AS batch_title,
              ii.checklist_item_id, COALESCE(ii.item_label, ci.label) AS item_label, ci.warn_pct, ci.crit_pct
       FROM inspection_item_volumes v
       JOIN inspection_items ii ON ii.id = v.inspection_item_id
       JOIN inspection_batches b ON b.id = ii.batch_id
       JOIN assets a ON a.id = ii.asset_id
       JOIN checklist_items ci ON ci.id = ii.checklist_item_id
       ORDER BY a.name ASC, b.batch_date ASC, b.id ASC, v.sort_order ASC`
    ).all();
  },

  assetIdsWithData() {
    return new Set(db.prepare(
      `SELECT DISTINCT ii.asset_id FROM inspection_item_volumes v JOIN inspection_items ii ON ii.id = v.inspection_item_id`
    ).all().map(r => r.asset_id));
  },

  // 把一串原始資料（seriesForAsset／allRows）依「設備＋項目＋磁碟區」分組成趨勢序列，並附上最新使用率與預測
  buildSeries(rows) {
    const map = new Map();
    for (const r of rows) {
      const volume = r.volume || r.name;
      const key = `${r.asset_id || ''}|${r.checklist_item_id}|${String(volume).toLowerCase()}`;
      if (!map.has(key)) {
        map.set(key, { asset_id: r.asset_id, asset_name: r.asset_name, category: r.category, location: r.location, is_active: r.is_active,
          item_id: r.checklist_item_id, item_label: r.item_label, volume, warn_pct: r.warn_pct || 85, crit_pct: r.crit_pct || 95, points: [] });
      }
      const s = map.get(key);
      s.item_label = r.item_label;
      s.points.push({ date: r.date, used_gb: r.used_gb, total_gb: r.total_gb, batch_id: r.batch_id, pct: capacity.pct(r) });
    }
    return [...map.values()].map(s => {
      const last = s.points[s.points.length - 1];
      return { ...s, last, forecast: capacity.forecast(s.points) };
    });
  },
};

module.exports = InspectionVolume;
