// 「待處理項目」：每台設備的每個檢查項目，只看「最新一次」巡檢的結果，最新一次是警告或異常才算（舊批次裡已經恢復正常的不會一直卡著）。
// 草稿批次也算（巡檢當下就該看得到）。只列啟用中的設備。連續次數＝從最新一次往前，連續幾次巡檢都是警告／異常。
const db = require('./db');
const AssetTag = require('./AssetTag');
const InspectionVolume = require('./InspectionVolume');
const capacity = require('../utils/capacity');

const OpenIssues = {
  // 回傳全部（未篩選）的待處理項目：[{ item_id, status, asset_id, asset_name, category, location, tags, label, value_text,
  //   volumes, note, batch_id, batch_title, batch_date, batch_status, approval_status, streak, checklist_item_id }]
  loadAll() {
    const rows = db.prepare(
      `WITH ranked AS (
         SELECT ii.id, ii.asset_id, ii.checklist_item_id, ii.status, ii.value_text, ii.note, ii.item_label, ii.batch_id,
                b.batch_date, b.title AS batch_title, b.status AS batch_status, b.approval_status,
                ROW_NUMBER() OVER (PARTITION BY ii.asset_id, ii.checklist_item_id ORDER BY b.batch_date DESC, b.id DESC) AS rn
         FROM inspection_items ii JOIN inspection_batches b ON b.id = ii.batch_id
       )
       SELECT r.id AS item_id, r.status, r.asset_id, a.name AS asset_name, a.category, a.location,
              r.checklist_item_id, COALESCE(r.item_label, ci.label) AS label, r.value_text, r.note,
              r.batch_id, r.batch_title, r.batch_date, r.batch_status, r.approval_status
       FROM ranked r
       JOIN assets a ON a.id = r.asset_id AND a.is_active = 1
       JOIN checklist_items ci ON ci.id = r.checklist_item_id
       WHERE r.rn = 1 AND r.status IN ('warning', 'critical')
       ORDER BY CASE r.status WHEN 'critical' THEN 0 ELSE 1 END, r.batch_date DESC, a.name ASC`
    ).all();
    if (rows.length === 0) return rows;

    // 連續次數：撈出這些設備全部的歷史狀態，依日期新到舊，數連續非正常的次數
    const assetIds = [...new Set(rows.map(r => r.asset_id))];
    const history = new Map();
    for (let off = 0; off < assetIds.length; off += 500) {
      const chunk = assetIds.slice(off, off + 500);
      db.prepare(
        `SELECT ii.asset_id, ii.checklist_item_id, ii.status FROM inspection_items ii
         JOIN inspection_batches b ON b.id = ii.batch_id
         WHERE ii.asset_id IN (${chunk.map(() => '?').join(',')})
         ORDER BY b.batch_date DESC, b.id DESC`
      ).all(...chunk).forEach(h => {
        const key = `${h.asset_id}:${h.checklist_item_id}`;
        if (!history.has(key)) history.set(key, []);
        history.get(key).push(h.status);
      });
    }
    const stubs = assetIds.map(id => ({ id }));
    AssetTag.attach(stubs);
    const tagsByAsset = new Map(stubs.map(s => [s.id, s.tags]));
    InspectionVolume.attach(rows.map(r => { r.id = r.item_id; return r; }));

    for (const r of rows) {
      let streak = 0;
      for (const st of history.get(`${r.asset_id}:${r.checklist_item_id}`) || []) {
        if (st === 'normal') break;
        streak++;
      }
      r.streak = streak;
      r.tags = tagsByAsset.get(r.asset_id) || [];
      r.display = r.volumes.length > 0 ? capacity.volumeLines(r.volumes).join('\n') : (r.value_text || '');
    }
    return rows;
  },

  // 依條件篩選（在記憶體裡做；待處理項目的量不大）
  filter(rows, f) {
    return rows.filter(r =>
      (!f.severity || r.status === f.severity) &&
      (!f.category || r.category === f.category) &&
      (!f.location || r.location === f.location) &&
      (!f.tag || r.tags.includes(f.tag)) &&
      (!f.label || r.label === f.label) &&
      (!f.batch || r.batch_id === f.batch) &&
      (!f.minStreak || r.streak >= f.minStreak)
    );
  },
};

module.exports = OpenIssues;
