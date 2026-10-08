const express = require('express');
const router = express.Router();

const MailService = require('../services/MailService');
const Notification = require('../models/Notification');

// 掛在 /admin/mail，上層（routes/admin.js）已限定管理員。網址只帶固定代碼。
const FLASH_OK = { saved: '已儲存 Email 設定', resent: '已重新寄出' };
const FLASH_ERR = { notfound: '找不到這則通知', resendfail: '重寄失敗，原因請看寄送紀錄' };

function render(req, res, { error = null, testResult = null, form = null, status = 200 } = {}) {
  const view = MailService.settingsForView();
  res.status(status).render('admin/mail', {
    settings: form ? { ...view, ...form } : view,
    ready: MailService.isReady(),
    log: Notification.listForLog(50).map(n => ({ ...n, to: MailService.recipientFor(n) })),
    adminEmail: MailService.recipientFor(req.user) || '',
    testResult,
    ok: FLASH_OK[req.query.ok] || null,
    error: error || FLASH_ERR[req.query.err] || null,
  });
}

router.get('/', (req, res) => render(req, res));

router.post('/settings', (req, res) => {
  const parsed = MailService.validateSettings(req.body);
  if (parsed.error) {
    return render(req, res, {
      error: parsed.error, status: 400,
      form: { enabled: req.body.enabled === 'on', method: req.body.method === 'm365' ? 'm365' : 'smtp', smtp_host: req.body.smtp_host || '', smtp_port: req.body.smtp_port || 587, smtp_user: req.body.smtp_user || '', smtp_from: req.body.smtp_from || '', m365_tenant_id: req.body.m365_tenant_id || '', m365_client_id: req.body.m365_client_id || '', m365_from_address: req.body.m365_from_address || '', app_url: req.body.app_url || '' },
    });
  }
  MailService.saveSettings(parsed.value);
  console.log(`[Email] ${req.user.username} 更新 Email 通知設定：${parsed.value.enabled ? '啟用' : '停用'}，方式 ${parsed.value.method}`);
  res.redirect('/admin/mail?ok=saved');
});

router.post('/test', async (req, res, next) => {
  try {
    const to = (req.body.to || '').trim();
    const result = await MailService.sendTest(to);
    console.log(`[Email] ${req.user.username} 測試寄信 → ${to}：${result.status}`);
    render(req, res, { testResult: { to, ...result } });
  } catch (err) {
    next(err);
  }
});

router.post('/resend/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || !Notification.findById(id)) return res.redirect('/admin/mail?err=notfound');
    const result = await MailService.resend(id);
    res.redirect(result.ok ? '/admin/mail?ok=resent' : '/admin/mail?err=resendfail');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
