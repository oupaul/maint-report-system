const express = require('express');
const path = require('path');
const router = express.Router();

const config = require('../config');
const { requireLogin } = require('../middleware/auth');
const QuoteService = require('../services/QuoteService');
const QuotePdf = require('../services/QuotePdfService');
const OpenIssues = require('../models/OpenIssues');
const db = require('../models/db');

router.use(requireLogin);

const FLASH = {
  created: '已送出報價請求，業務會收到通知。',
  pending: '已建立報價請求，需要主管確認後才會通知業務。',
  confirmed: '已確認，已通知業務。',
  rejected: '已退回這張請求。',
  claimed: '已接手處理。',
  quoted: '已記錄報價，並通知送出請求的人。',
  closed: '已結案。',
  cancelled: '已取消這張請求。',
  reminded: '已再次提醒業務。',
  noted: '已留言。',
};

const parseId = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };
const settingsView = () => QuoteService.getSettings();

function loadAllowed(req, res) {
  const id = parseId(req.params.id);
  const request = id ? QuoteService.findRequest(id) : null;
  if (!request) { res.status(404).render('error', { title: '找不到報價請求', message: '找不到指定的報價請求' }); return null; }
  if (!QuoteService.canView(req.user, request)) { res.status(403).render('error', { title: '權限不足', message: '你沒有權限查看這張報價請求' }); return null; }
  return request;
}

// ---- 清單 ----
router.get('/', (req, res) => {
  const views = ['open', 'all', ...Object.keys(QuoteService.STATUS)];
  const view = views.includes(req.query.view) ? req.query.view : 'open';
  const params = { view, q: String(req.query.q || '').slice(0, 60), mine: req.query.mine === '1', page: req.query.page };
  const result = QuoteService.listFor(req.user, params);
  res.render('quotes/list', {
    ...result, params, STATUS: QuoteService.STATUS, views, counts: QuoteService.counts(req.user),
    handler: QuoteService.isHandler(req.user), settings: settingsView(),
  });
});

// ---- 統計（業務／管理員）----
router.get('/stats', (req, res) => {
  if (!QuoteService.isHandler(req.user)) return res.status(403).render('error', { title: '權限不足', message: '只有業務與管理員可以看報價統計' });
  res.render('quotes/stats', { s: QuoteService.stats(), STATUS: QuoteService.STATUS });
});

// ---- 新增 ----
function newPageData(user, firstItemId, selected) {
  const row = db.prepare(
    `SELECT ii.id, ii.asset_id, ii.status FROM inspection_items ii WHERE ii.id = ?`
  ).get(firstItemId);
  if (!row) return null;
  // 候選項目：被點的這一項＋這台設備目前所有警告／異常的項目（最新一次）
  const open = OpenIssues.loadAll().filter(r => r.asset_id === row.asset_id);
  const clicked = db.prepare(
    `SELECT ii.id AS item_id, ii.status, ii.asset_id, ii.checklist_item_id, COALESCE(ii.item_label, ci.label) AS label, ii.value_text, ii.note,
            b.id AS batch_id, b.title AS batch_title, b.batch_date, a.name AS asset_name
     FROM inspection_items ii JOIN checklist_items ci ON ci.id = ii.checklist_item_id JOIN inspection_batches b ON b.id = ii.batch_id JOIN assets a ON a.id = ii.asset_id
     WHERE ii.id = ?`
  ).get(firstItemId);
  const list = [clicked, ...open.filter(r => r.item_id !== firstItemId && r.checklist_item_id !== clicked.checklist_item_id)];
  const candidates = list.map(r => ({
    id: r.item_id, label: r.label, status: r.status, batch_title: r.batch_title, batch_date: r.batch_date,
    display: r.display || r.value_text || '', note: r.note || '',
    blocked: QuoteService.openRequestFor(r.asset_id, r.checklist_item_id) || null,
    allowed: r.status === 'warning' || r.status === 'critical',
  }));
  const picked = (selected && selected.length ? selected : [firstItemId]);
  return { assetName: clicked.asset_name, candidates, picked: new Set(picked), firstItemId };
}

function renderNew(req, res, firstItemId, { error = null, selected = null, urgency = 'normal', description = '', status = 200 } = {}) {
  const data = newPageData(req.user, firstItemId, selected);
  if (!data) return res.status(404).render('error', { title: '找不到項目', message: '找不到指定的檢查項目' });
  const settings = settingsView();
  const recipients = QuoteService.salesRecipients(req.user.id);
  res.status(status).render('quotes/new', {
    ...data, error, urgency, description, settings, recipients, max: QuoteService.MAX_ITEMS,
  });
}

router.get('/new', (req, res) => {
  if (!settingsView().enabled) return res.status(400).render('error', { title: '功能未啟用', message: '報價請求功能目前沒有啟用' });
  const id = parseId(req.query.item);
  if (!id) return res.redirect('/issues');
  renderNew(req, res, id);
});

router.post('/new', (req, res) => {
  const first = parseId(req.body.first);
  const items = [].concat(req.body.items || []);
  const result = QuoteService.create(req.user, { itemIds: items, urgency: req.body.urgency, description: req.body.description });
  if (!result.ok) {
    if (!first) return res.status(result.status || 400).render('error', { title: '無法建立報價請求', message: result.error });
    return renderNew(req, res, first, { error: result.error, selected: items.map(Number), urgency: req.body.urgency, description: req.body.description, status: result.status || 400 });
  }
  console.log(`[報價請求] ${req.user.username} 建立 Q-${result.id}（${result.status}）`);
  res.redirect(`/quotes/${result.id}?ok=${result.status === 'pending_confirm' ? 'pending' : 'created'}`);
});

// ---- 詳細 ----
function renderShow(req, res, request, { error = null, status = 200 } = {}) {
  const detail = QuoteService.getDetail(request.id);
  const settings = settingsView();
  const user = req.user;
  const handler = QuoteService.isHandler(user);
  const isRequester = request.requested_by === user.id;
  const isAdmin = user.role === 'admin';
  const st = request.status;
  res.status(status).render('quotes/show', {
    ...detail, error, settings, STATUS: QuoteService.STATUS, URGENCY: QuoteService.URGENCY,
    ok: FLASH[req.query.ok] || null,
    visibleLines: QuotePdf.visibleAssetLines(detail.asset, settings),
    perm: { // 注意不能叫 can：會蓋掉 layout 用的全域 can()
      confirm: isAdmin && st === 'pending_confirm',
      claim: handler && st === 'sent',
      quote: handler && (st === 'sent' || st === 'processing'),
      close: handler && ['sent', 'processing', 'quoted'].includes(st),
      cancel: (isRequester || isAdmin) && ['pending_confirm', 'sent', 'processing'].includes(st),
      remind: (isRequester || isAdmin) && (st === 'sent' || st === 'processing'),
    },
  });
}

router.get('/:id', (req, res) => {
  const request = loadAllowed(req, res);
  if (request) renderShow(req, res, request);
});

router.get('/:id/photo/:photoId', (req, res) => {
  const request = loadAllowed(req, res);
  if (!request) return;
  const photo = db.prepare(
    `SELECT p.path FROM quote_request_photos p JOIN quote_request_items i ON i.id = p.item_id WHERE p.id = ? AND i.request_id = ?`
  ).get(parseId(req.params.photoId), request.id);
  const root = path.join(config.UPLOADS_DIR, 'quotes', String(request.id)) + path.sep;
  if (!photo || !path.resolve(photo.path).startsWith(root)) return res.status(404).end();
  res.sendFile(path.resolve(photo.path));
});

router.get('/:id/pdf', async (req, res, next) => {
  try {
    const request = loadAllowed(req, res);
    if (!request) return;
    const pdf = await QuotePdf.generate(QuoteService.getDetail(request.id), settingsView());
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="quote-request-Q${request.id}.pdf"` });
    res.send(pdf);
  } catch (e) { next(e); }
});

// ---- 動作 ----
function act(name, fn, okKey) {
  router.post(`/:id/${name}`, (req, res) => {
    const request = loadAllowed(req, res);
    if (!request) return;
    const result = fn(request.id, req.user, req.body);
    if (!result.ok) return renderShow(req, res, request, { error: result.error, status: result.status || 400 });
    console.log(`[報價請求] ${req.user.username} 對 Q-${request.id} 執行 ${name}`);
    res.redirect(`/quotes/${request.id}?ok=${okKey}`);
  });
}
act('confirm', (id, u) => QuoteService.confirm(id, u), 'confirmed');
act('reject', (id, u, b) => QuoteService.reject(id, u, b.reason), 'rejected');
act('claim', (id, u) => QuoteService.claim(id, u), 'claimed');
act('quote', (id, u, b) => QuoteService.quote(id, u, b), 'quoted');
act('close', (id, u, b) => QuoteService.close(id, u, b.note), 'closed');
act('cancel', (id, u, b) => QuoteService.cancel(id, u, b.reason), 'cancelled');
act('remind', (id, u) => QuoteService.remind(id, u), 'reminded');
act('note', (id, u, b) => QuoteService.addNote(id, u, b.text), 'noted');

module.exports = router;
