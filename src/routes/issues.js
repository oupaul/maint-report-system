const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const OpenIssues = require('../models/OpenIssues');
const AssetCategory = require('../models/AssetCategory');
const ApprovalService = require('../services/ApprovalService');
const { toCsv } = require('../utils/csv');
const QuoteService = require('../services/QuoteService');
const IssueTriage = require('../models/IssueTriage');
const db = require('../models/db');

const PER_PAGE = 100;

function parseFilters(query) {
  const str = (v, max = 100) => String(v || '').slice(0, max);
  const num = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : 0; };
  return {
    severity: ['critical', 'warning'].includes(query.severity) ? query.severity : '',
    category: str(query.category, 60),
    location: str(query.location),
    customer: query.customer === 'none' ? 'none' : (/^\d{1,9}$/.test(String(query.customer || '')) ? String(query.customer) : ''),
    tag: str(query.tag, 40),
    label: str(query.label, 60),
    batch: num(query.batch),
    minStreak: [2, 3].includes(num(query.streak)) ? num(query.streak) : 0,
    quote: ['none', 'open', 'done'].includes(query.quote) ? query.quote : '', // 報價狀態：尚未通知業務／進行中／已完成
    triage: ['none', ...Object.keys(IssueTriage.DISPOSITIONS)].includes(query.triage) ? query.triage : '', // 處理建議：none＝未分流
  };
}

// 批次的狀態文字（草稿／審核中…）與能不能直接去填寫頁（草稿且沒被鎖定）
function batchInfo(r) {
  const info = ApprovalService.statusInfo({ status: r.batch_status, approval_status: r.approval_status, id: r.batch_id });
  return { ...info, editable: r.batch_status === 'draft' && !ApprovalService.isLocked({ status: r.batch_status, approval_status: r.approval_status }) };
}

// 每個項目最新的報價請求狀態（掛在 row.quote）；quote 篩選在這裡做
function withQuotes(rows) {
  const map = QuoteService.latestByPair();
  const settings = QuoteService.getSettings();
  rows.forEach(r => {
    r.quote = map.get(`${r.asset_id}:${r.checklist_item_id}`) || null;
    // 這個項目現在能不能直接按「通知業務報價」：異常可以；警告要先分流成「需要報價」（或管理員開了「警告也可直接送」）
    r.canQuote = r.status === 'critical' || !!settings.allow_warning_direct || !!(r.triage && r.triage.disposition === 'quote');
  });
  return rows;
}
const quoteBucket = (r) => (!r.quote ? 'none' : (QuoteService.OPEN.includes(r.quote.status) ? 'open' : 'done'));
const filterQuote = (rows, f) => (f.quote ? rows.filter(r => quoteBucket(r) === f.quote) : rows);

router.get('/', requireLogin, (req, res) => {
  const f = parseFilters(req.query);
  const all = withQuotes(OpenIssues.loadAll());
  // 還沒分流的排前面（再依異常優先、日期新到舊：loadAll 已排好，這裡是穩定排序）
  const rows = filterQuote(OpenIssues.filter(all, f), f).sort((a, b) => (a.triage ? 1 : 0) - (b.triage ? 1 : 0));
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);

  // 篩選選項來自「未篩選」的全部待處理項目，這樣選了一個條件之後其他選項不會消失
  const uniq = (arr) => [...new Set(arr)].filter(Boolean);
  const link = (over = {}) => {
    const m = { ...f, streak: f.minStreak, ...over };
    delete m.minStreak;
    const qs = new URLSearchParams();
    Object.entries(m).forEach(([k, v]) => { if (v) qs.set(k, v); });
    const t = qs.toString();
    return '/issues' + (t ? '?' + t : '');
  };
  const countOf = (sev) => filterQuote(OpenIssues.filter(all, { ...f, severity: sev }), f).length;

  res.render('issues/list', {
    f, page, pages, link,
    flash: { triaged: '已儲存處理建議。', cleared: '已取消分流（這個項目改回未分流）。' }[req.query.ok] || null,
    total: all.length,
    matched: rows.length,
    rows: rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(r => ({ ...r, batchInfo: batchInfo(r) })),
    counts: { critical: countOf('critical'), warning: countOf('warning') },
    quoteEnabled: !!QuoteService.getSettings().enabled,
    DISPOSITIONS: IssueTriage.DISPOSITIONS,
    untriaged: all.filter(r => !r.triage).length,
    STATUS: QuoteService.STATUS,
    categoryLabels: AssetCategory.labelMap(),
    categoryCodes: uniq(all.map(r => r.category)),
    locations: uniq(all.map(r => r.location)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    customerOptions: [...new Map(all.filter(r => r.customer_id).map(r => [r.customer_id, r.customer_name])).entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')),
    hasUnassigned: all.some(r => !r.customer_id),
    tags: uniq(all.flatMap(r => r.tags)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    labels: uniq(all.map(r => r.label)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    batches: [...new Map(all.map(r => [r.batch_id, { id: r.batch_id, title: r.batch_title, date: r.batch_date }])).values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

router.get('/export.csv', requireLogin, (req, res) => {
  const labels = AssetCategory.labelMap();
  const exportFilters = parseFilters(req.query);
  const rows = filterQuote(OpenIssues.filter(withQuotes(OpenIssues.loadAll()), exportFilters), exportFilters);
  const header = ['嚴重度', '設備', '客戶', '類別', '位置', '檢查項目', '數值', '備註', '最新巡檢日期', '巡檢批次', '批次狀態', '連續次數', '處理建議', '系統建議', '報價狀態'];
  const lines = [header, ...rows.map(r => [
    r.status === 'critical' ? '異常' : '警告', r.asset_name, r.customer_name || '', labels[r.category] || r.category, r.location || '', r.label,
    r.display.replace(/\n/g, '；'), r.note || '', r.batch_date, r.batch_title, batchInfo(r).text, r.streak, r.triage ? `${IssueTriage.DISPOSITIONS[r.triage.disposition]}${r.triage.review_date ? `（${r.triage.review_date}）` : ''}${r.triage.note ? `：${r.triage.note}` : ''}` : (r.resurfaced ? `未分流（${r.resurfaced}）` : '未分流'), r.hint.text, r.quote ? `Q-${r.quote.id} ${QuoteService.STATUS[r.quote.status]}` : '尚未通知',
  ])];
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="open-issues-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(toCsv(lines));
});

// ---- 處理建議（分流）----
function loadTriagePage(req, res, { error = null, status = 200 } = {}) {
  const id = parseInt(req.query.item || req.body.item, 10);
  const item = Number.isInteger(id) ? db.prepare(
    `SELECT ii.id, ii.asset_id, ii.checklist_item_id, a.name AS asset_name, a.is_active, COALESCE(ii.item_label, ci.label) AS label
     FROM inspection_items ii JOIN assets a ON a.id = ii.asset_id JOIN checklist_items ci ON ci.id = ii.checklist_item_id WHERE ii.id = ?`
  ).get(id) : null;
  if (!item) { res.status(404).render('error', { title: '找不到項目', message: '找不到指定的檢查項目' }); return null; }
  // 以這個「設備＋檢查項目」目前的狀況為準（最新一次巡檢），不是被點的那一次
  const row = OpenIssues.loadAll().find(r => r.asset_id === item.asset_id && r.checklist_item_id === item.checklist_item_id);
  const rec = IssueTriage.get(item.asset_id, item.checklist_item_id);
  res.status(status).render('issues/triage', {
    item, row: row || null, rec: row ? (row.triage || null) : null, hasRecord: !!rec,
    history: IssueTriage.history(item.asset_id, item.checklist_item_id),
    DISPOSITIONS: IssueTriage.DISPOSITIONS, defaultReview: IssueTriage.addDays(IssueTriage.OBSERVE_DEFAULT_DAYS),
    error, quoteEnabled: !!QuoteService.getSettings().enabled, today: IssueTriage.todayTaipei(),
    form: req.body && req.body.disposition !== undefined ? req.body : null,
  });
  return item;
}

router.get('/triage', requireLogin, (req, res) => { loadTriagePage(req, res); });

router.post('/triage', requireLogin, (req, res) => {
  const id = parseInt(req.body.item, 10);
  const item = Number.isInteger(id) ? db.prepare('SELECT asset_id, checklist_item_id FROM inspection_items WHERE id = ?').get(id) : null;
  if (!item) return res.status(404).render('error', { title: '找不到項目', message: '找不到指定的檢查項目' });
  const latest = IssueTriage.latestResult(item.asset_id, item.checklist_item_id);
  if (!latest || latest.status === 'normal') return loadTriagePage(req, res, { error: '這個項目最新一次巡檢已經是正常，不需要分流', status: 400 });
  const v = IssueTriage.validate({ disposition: String(req.body.disposition || ''), note: req.body.note, reviewDate: req.body.review_date });
  if (v.error) return loadTriagePage(req, res, { error: v.error, status: 400 });
  if (v.clear) {
    IssueTriage.clear(item.asset_id, item.checklist_item_id, req.user.id);
    return res.redirect('/issues?ok=cleared');
  }
  IssueTriage.save(item.asset_id, item.checklist_item_id, v.value, req.user.id);
  console.log(`[處理建議] ${req.user.username} 將項目 #${id} 標為 ${v.value.disposition}`);
  // 選「需要報價」就接著去填報價請求（沒送出也沒關係，清單會顯示「需要報價・尚未送出」）
  if (v.value.disposition === 'quote' && QuoteService.getSettings().enabled) return res.redirect(`/quotes/new?item=${latest.item_id}`);
  res.redirect('/issues?ok=triaged');
});

module.exports = router;
module.exports.summary = () => {
  const all = OpenIssues.loadAll();
  const open = all.filter(r => !r.triage); // 只算還沒分流的（已分流的不再催）
  return {
    critical: open.filter(r => r.status === 'critical').length,
    warning: open.filter(r => r.status === 'warning').length,
    triaged: all.length - open.length,
    top: open.slice(0, 5).map(r => ({ ...r, batchInfo: batchInfo(r) })), // loadAll 已依「異常在前、日期新到舊」排好
  };
};
