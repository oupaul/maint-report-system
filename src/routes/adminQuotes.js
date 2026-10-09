const express = require('express');
const router = express.Router();

const QuoteService = require('../services/QuoteService');

// 掛在 /admin/quotes（routes/admin.js 已限定管理員）：報價請求的設定
function render(res, { error = null, ok = null, form = null, status = 200 } = {}) {
  res.status(status).render('admin/quotes', {
    form: form || QuoteService.getSettings(), error, ok,
    sales: QuoteService.salesRecipients(),
    salesGroups: QuoteService.receiveGroups(),
  });
}

router.get('/', (req, res) => render(res, { ok: req.query.ok === '1' ? '已儲存設定' : null }));

router.post('/', (req, res) => {
  const parsed = QuoteService.validateSettings(req.body);
  if (parsed.error) return render(res, { error: parsed.error, form: { ...req.body, notify_group_id: req.body.notify_group_id ? Number(req.body.notify_group_id) : null, enabled: req.body.enabled ? 1 : 0, attach_pdf: req.body.attach_pdf ? 1 : 0, show_ip: req.body.show_ip ? 1 : 0, show_mac: req.body.show_mac ? 1 : 0, show_serial: req.body.show_serial ? 1 : 0, show_purchase: req.body.show_purchase ? 1 : 0, show_custom: req.body.show_custom ? 1 : 0, require_confirm: req.body.require_confirm ? 1 : 0 }, status: 400 });
  QuoteService.saveSettings(parsed.values);
  console.log(`[報價請求] ${req.user.username} 修改了報價請求設定`);
  res.redirect('/admin/quotes?ok=1');
});

module.exports = router;
