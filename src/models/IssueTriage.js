// 待處理項目的「處理建議」（分流）：持續觀察／排程處理／需要報價／已處理。跟著「設備＋檢查項目」走，不是某一次巡檢。
// 一筆處理建議在這些情況會「失效」，讓項目重新回到「未分流」（evaluate 負責判斷，並回傳重新浮出的原因）：
//   · 是新的一輪問題（中間恢復過正常，現在的警告／異常是之後才開始的）
//   · 持續觀察：複查日期到了，或狀態從警告惡化成異常
//   · 排程處理：預計日期已過還沒處理
//   · 已處理：標記之後的巡檢結果仍然是警告／異常
const db = require('./db');
const { nowTaipei } = require('../utils/time');

const DISPOSITIONS = { observe: '持續觀察', scheduled: '排程處理', quote: '需要報價', resolved: '已處理／不需處理' };
const OBSERVE_DEFAULT_DAYS = 30;
const MAX_NOTE = 500;

const todayTaipei = () => nowTaipei().slice(0, 10);
const addDays = (n) => new Date(Date.now() + 8 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

// rec：issue_triage 的一列（可為 undefined）；ctx：{ latestStatus, latestBatchDate, streakStart }
// 回傳 { triage, resurfaced }：triage 為 null 代表「未分流」（resurfaced 是它重新浮出的原因，沒有就是從沒分流過）
function evaluate(rec, ctx) {
  if (!rec) return { triage: null, resurfaced: null };
  if (ctx.streakStart && rec.set_batch_date && ctx.streakStart > rec.set_batch_date) return { triage: null, resurfaced: null }; // 前一輪問題的分流
  const today = todayTaipei();
  switch (rec.disposition) {
    case 'observe':
      if (ctx.latestStatus === 'critical' && rec.status_at_set === 'warning') return { triage: null, resurfaced: '已惡化（原本是警告，現在是異常）' };
      if (rec.review_date && rec.review_date < today) return { triage: null, resurfaced: `複查日期（${rec.review_date}）已到` };
      return { triage: rec, resurfaced: null };
    case 'scheduled':
      if (rec.review_date && rec.review_date < today) return { triage: null, resurfaced: `排程日期（${rec.review_date}）已過，還沒處理` };
      return { triage: rec, resurfaced: null };
    case 'resolved':
      if (ctx.latestBatchDate && rec.set_batch_date && ctx.latestBatchDate > rec.set_batch_date) return { triage: null, resurfaced: '標記已處理之後的巡檢，這個項目仍然是警告／異常' };
      return { triage: rec, resurfaced: null };
    default:
      return { triage: rec, resurfaced: null };
  }
}

const IssueTriage = {
  DISPOSITIONS, OBSERVE_DEFAULT_DAYS, MAX_NOTE, evaluate, todayTaipei, addDays,

  get(assetId, checklistItemId) {
    return db.prepare('SELECT * FROM issue_triage WHERE asset_id = ? AND checklist_item_id = ?').get(assetId, checklistItemId);
  },

  // 全部處理建議：Map('asset:item' → 列)，附上修改人名稱
  mapAll() {
    const rows = db.prepare(
      `SELECT t.*, u.display_name AS un1, u.username AS un2 FROM issue_triage t LEFT JOIN users u ON u.id = t.updated_by`
    ).all();
    return new Map(rows.map(r => [`${r.asset_id}:${r.checklist_item_id}`, { ...r, updated_by_name: r.un1 || r.un2 || '' }]));
  },

  // 單一「設備＋檢查項目」目前有效的處理建議（沒有或已失效回傳 null）。給報價請求檢查「警告能不能直接送」用
  activeFor(assetId, checklistItemId) {
    const rec = IssueTriage.get(assetId, checklistItemId);
    if (!rec) return null;
    const hist = db.prepare(
      `SELECT ii.status, b.batch_date FROM inspection_items ii JOIN inspection_batches b ON b.id = ii.batch_id
       WHERE ii.asset_id = ? AND ii.checklist_item_id = ? ORDER BY b.batch_date DESC, b.id DESC`
    ).all(assetId, checklistItemId);
    if (hist.length === 0 || hist[0].status === 'normal') return null;
    let streakStart = hist[0].batch_date;
    for (const h of hist) { if (h.status === 'normal') break; streakStart = h.batch_date; }
    return evaluate(rec, { latestStatus: hist[0].status, latestBatchDate: hist[0].batch_date, streakStart }).triage;
  },

  // 這個「設備＋檢查項目」最新一次巡檢的狀態與日期（標記當下記下來）
  latestResult(assetId, checklistItemId) {
    return db.prepare(
      `SELECT ii.status, ii.id AS item_id, b.batch_date FROM inspection_items ii JOIN inspection_batches b ON b.id = ii.batch_id
       WHERE ii.asset_id = ? AND ii.checklist_item_id = ? ORDER BY b.batch_date DESC, b.id DESC LIMIT 1`
    ).get(assetId, checklistItemId);
  },

  validate({ disposition, note, reviewDate }) {
    if (disposition === '') return { clear: true };
    if (!Object.prototype.hasOwnProperty.call(DISPOSITIONS, disposition)) return { error: '請選擇處理建議' };
    const text = String(note || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_NOTE);
    let date = String(reviewDate || '').trim();
    const today = todayTaipei();
    if (disposition === 'observe' || disposition === 'scheduled') {
      if (!date && disposition === 'observe') date = addDays(OBSERVE_DEFAULT_DAYS);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) {
        return { error: disposition === 'observe' ? '請填複查日期（年-月-日）' : '請填預計處理日期（年-月-日）' };
      }
      if (date < today) return { error: '日期不能是過去的日期' };
      if (date > addDays(730)) return { error: '日期太遠了（最多 2 年內）' };
    } else {
      date = '';
    }
    if (disposition === 'resolved' && !text) return { error: '標記為已處理／不需處理時，請寫下原因（例如：已更換硬碟、客戶不處理）' };
    return { value: { disposition, note: text || null, review_date: date || null } };
  },

  // 儲存（含記錄）。userId：操作者
  save(assetId, checklistItemId, { disposition, note, review_date }, userId) {
    const latest = IssueTriage.latestResult(assetId, checklistItemId);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO issue_triage (asset_id, checklist_item_id, disposition, note, review_date, status_at_set, set_batch_date, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id, checklist_item_id) DO UPDATE SET disposition = excluded.disposition, note = excluded.note, review_date = excluded.review_date,
           status_at_set = excluded.status_at_set, set_batch_date = excluded.set_batch_date, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(assetId, checklistItemId, disposition, note || null, review_date || null, latest ? latest.status : null, latest ? latest.batch_date : null, userId, nowTaipei());
      IssueTriage.log(assetId, checklistItemId, disposition, note, review_date, userId);
    })();
  },

  clear(assetId, checklistItemId, userId) {
    db.transaction(() => {
      db.prepare('DELETE FROM issue_triage WHERE asset_id = ? AND checklist_item_id = ?').run(assetId, checklistItemId);
      IssueTriage.log(assetId, checklistItemId, null, '取消分流（改回未分流）', null, userId);
    })();
  },

  log(assetId, checklistItemId, disposition, note, reviewDate, userId) {
    db.prepare(
      'INSERT INTO issue_triage_log (asset_id, checklist_item_id, disposition, note, review_date, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(assetId, checklistItemId, disposition, note || null, reviewDate || null, userId, nowTaipei());
  },

  history(assetId, checklistItemId, limit = 20) {
    return db.prepare(
      `SELECT l.*, u.display_name, u.username FROM issue_triage_log l LEFT JOIN users u ON u.id = l.user_id
       WHERE l.asset_id = ? AND l.checklist_item_id = ? ORDER BY l.id DESC LIMIT ?`
    ).all(assetId, checklistItemId, limit).map(r => ({ ...r, who: r.display_name || r.username || '系統' }));
  },
};

module.exports = IssueTriage;
