const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const OpenIssues = require('../models/OpenIssues');
const AssetCategory = require('../models/AssetCategory');
const ApprovalService = require('../services/ApprovalService');
const { toCsv } = require('../utils/csv');
const QuoteService = require('../services/QuoteService');

const PER_PAGE = 100;

function parseFilters(query) {
  const str = (v, max = 100) => String(v || '').slice(0, max);
  const num = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : 0; };
  return {
    severity: ['critical', 'warning'].includes(query.severity) ? query.severity : '',
    category: str(query.category, 60),
    location: str(query.location),
    tag: str(query.tag, 40),
    label: str(query.label, 60),
    batch: num(query.batch),
    minStreak: [2, 3].includes(num(query.streak)) ? num(query.streak) : 0,
    quote: ['none', 'open', 'done'].includes(query.quote) ? query.quote : '', // 報價狀態：尚未通知業務／進行中／已完成
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
  rows.forEach(r => { r.quote = map.get(`${r.asset_id}:${r.checklist_item_id}`) || null; });
  return rows;
}
const quoteBucket = (r) => (!r.quote ? 'none' : (QuoteService.OPEN.includes(r.quote.status) ? 'open' : 'done'));
const filterQuote = (rows, f) => (f.quote ? rows.filter(r => quoteBucket(r) === f.quote) : rows);

router.get('/', requireLogin, (req, res) => {
  const f = parseFilters(req.query);
  const all = withQuotes(OpenIssues.loadAll());
  const rows = filterQuote(OpenIssues.filter(all, f), f);
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
    total: all.length,
    matched: rows.length,
    rows: rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(r => ({ ...r, batchInfo: batchInfo(r) })),
    counts: { critical: countOf('critical'), warning: countOf('warning') },
    quoteEnabled: !!QuoteService.getSettings().enabled,
    STATUS: QuoteService.STATUS,
    categoryLabels: AssetCategory.labelMap(),
    categoryCodes: uniq(all.map(r => r.category)),
    locations: uniq(all.map(r => r.location)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    tags: uniq(all.flatMap(r => r.tags)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    labels: uniq(all.map(r => r.label)).sort((a, b) => a.localeCompare(b, 'zh-Hant')),
    batches: [...new Map(all.map(r => [r.batch_id, { id: r.batch_id, title: r.batch_title, date: r.batch_date }])).values()].sort((a, b) => (a.date < b.date ? 1 : -1)),
  });
});

router.get('/export.csv', requireLogin, (req, res) => {
  const labels = AssetCategory.labelMap();
  const exportFilters = parseFilters(req.query);
  const rows = filterQuote(OpenIssues.filter(withQuotes(OpenIssues.loadAll()), exportFilters), exportFilters);
  const header = ['嚴重度', '設備', '類別', '位置', '檢查項目', '數值', '備註', '最新巡檢日期', '巡檢批次', '批次狀態', '連續次數', '報價狀態'];
  const lines = [header, ...rows.map(r => [
    r.status === 'critical' ? '異常' : '警告', r.asset_name, labels[r.category] || r.category, r.location || '', r.label,
    r.display.replace(/\n/g, '；'), r.note || '', r.batch_date, r.batch_title, batchInfo(r).text, r.streak, r.quote ? `Q-${r.quote.id} ${QuoteService.STATUS[r.quote.status]}` : '尚未通知',
  ])];
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="open-issues-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send(toCsv(lines));
});

module.exports = router;
module.exports.summary = () => {
  const all = OpenIssues.loadAll();
  return {
    critical: all.filter(r => r.status === 'critical').length,
    warning: all.filter(r => r.status === 'warning').length,
    top: all.slice(0, 5).map(r => ({ ...r, batchInfo: batchInfo(r) })), // loadAll 已依「異常在前、日期新到舊」排好
  };
};
