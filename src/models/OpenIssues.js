// 「待處理項目」：每台設備的每個檢查項目，只看「最新一次」巡檢的結果，最新一次是警告或異常才算（舊批次裡已經恢復正常的不會一直卡著）。
// 草稿批次也算（巡檢當下就該看得到）。只列啟用中的設備。連續次數＝從最新一次往前，連續幾次巡檢都是警告／異常。
const db = require('./db');
const AssetTag = require('./AssetTag');
const InspectionVolume = require('./InspectionVolume');
const capacity = require('../utils/capacity');
const IssueTriage = require('./IssueTriage');
const Asset = require('./Asset');

// 系統給的建議（只是提示，最後由工程師決定）：tone＝quote／schedule／observe
function buildHint(r, ctx) {
  const parts = [];
  const warranty = (ctx.warrantyByAsset.get(r.asset_id) || null);
  if (warranty) parts.push(`已過保固期（${warranty}）`);
  // 容量型：用預測推估
  let capHint = null;
  const series = (ctx.seriesByAsset.get(r.asset_id) || []).filter(x => x.item_id === r.checklist_item_id);
  if (series.length > 0) {
    const days = series.map(x => (x.forecast && x.forecast.ok ? (x.forecast.reached ? 0 : (x.forecast.daysToTarget != null ? x.forecast.daysToTarget : Infinity)) : null)).filter(d => d != null);
    if (days.length > 0) {
      const min = Math.min(...days);
      if (min <= 90) capHint = { tone: 'quote', text: min === 0 ? '使用率已達 90% 以上，建議評估報價擴充' : `預估約 ${Math.max(1, Math.round(min))} 天後達 90%，建議評估報價擴充` };
      else if (min <= 365) capHint = { tone: 'schedule', text: `預估約 ${Math.round(min / 30)} 個月後達 90%，建議排程擴充` };
      else capHint = { tone: 'observe', text: '成長緩慢或沒有上升趨勢，建議持續觀察' };
    }
  }
  let main;
  if (r.status === 'critical') main = { tone: 'quote', text: '異常項目，建議評估報價或立即處理' };
  else if (r.streak >= 3) main = { tone: 'quote', text: `反覆發生（連續 ${r.streak} 次警告），建議評估報價` };
  else if (capHint) main = capHint;
  else main = { tone: 'observe', text: '警告等級，建議先持續觀察' };
  if (parts.length) main = { tone: main.tone === 'observe' ? 'schedule' : main.tone, text: `${main.text}；${parts.join('；')}` };
  return main;
}

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
       SELECT r.id AS item_id, r.status, r.asset_id, a.name AS asset_name, a.category, a.location, a.customer_id, cu.name AS customer_name,
              r.checklist_item_id, COALESCE(r.item_label, ci.label) AS label, r.value_text, r.note,
              r.batch_id, r.batch_title, r.batch_date, r.batch_status, r.approval_status
       FROM ranked r
       JOIN assets a ON a.id = r.asset_id AND a.is_active = 1
       LEFT JOIN customers cu ON cu.id = a.customer_id
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
        `SELECT ii.asset_id, ii.checklist_item_id, ii.status, b.batch_date FROM inspection_items ii
         JOIN inspection_batches b ON b.id = ii.batch_id
         WHERE ii.asset_id IN (${chunk.map(() => '?').join(',')})
         ORDER BY b.batch_date DESC, b.id DESC`
      ).all(...chunk).forEach(h => {
        const key = `${h.asset_id}:${h.checklist_item_id}`;
        if (!history.has(key)) history.set(key, []);
        history.get(key).push({ status: h.status, date: h.batch_date });
      });
    }
    const stubs = assetIds.map(id => ({ id }));
    AssetTag.attach(stubs);
    const tagsByAsset = new Map(stubs.map(s => [s.id, s.tags]));
    InspectionVolume.attach(rows.map(r => { r.id = r.item_id; return r; }));

    // 處理建議、容量預測、保固：一次撈好再逐列套用
    const triageMap = IssueTriage.mapAll();
    const volumeAssets = new Set(rows.filter(r => r.volumes.length > 0).map(r => r.asset_id));
    const seriesByAsset = new Map();
    if (volumeAssets.size > 0) {
      InspectionVolume.buildSeries(InspectionVolume.allRows().filter(x => volumeAssets.has(x.asset_id))).forEach(s => {
        if (!seriesByAsset.has(s.asset_id)) seriesByAsset.set(s.asset_id, []);
        seriesByAsset.get(s.asset_id).push(s);
      });
    }
    const today = IssueTriage.todayTaipei();
    const warrantyByAsset = new Map();
    Asset.findByIds(assetIds).forEach(a => {
      const w = (a.customDisplay || []).find(c => c.type === 'date' && /保固|warranty/i.test(c.label) && c.text < today);
      if (w) warrantyByAsset.set(a.id, w.text);
    });

    for (const r of rows) {
      const hist = history.get(`${r.asset_id}:${r.checklist_item_id}`) || [];
      let streak = 0;
      let streakStart = r.batch_date;
      for (const h of hist) {
        if (h.status === 'normal') break;
        streak++;
        streakStart = h.date;
      }
      r.streak = streak;
      const ev = IssueTriage.evaluate(triageMap.get(`${r.asset_id}:${r.checklist_item_id}`), { latestStatus: r.status, latestBatchDate: r.batch_date, streakStart });
      r.triage = ev.triage;
      r.resurfaced = ev.resurfaced;
      r.hint = buildHint(r, { warrantyByAsset, seriesByAsset });
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
      (!f.customer || (f.customer === 'none' ? !r.customer_id : String(r.customer_id) === String(f.customer))) &&
      (!f.tag || r.tags.includes(f.tag)) &&
      (!f.label || r.label === f.label) &&
      (!f.batch || r.batch_id === f.batch) &&
      (!f.minStreak || r.streak >= f.minStreak) &&
      (!f.triage || (f.triage === 'none' ? !r.triage : (r.triage && r.triage.disposition === f.triage)))
    );
  },
};

module.exports = OpenIssues;
