const express = require('express');
const router = express.Router();

const Customer = require('../models/Customer');

// 掛在 /admin/customers（routes/admin.js 以「管理資產建檔」權限保護）。網址只帶固定代碼，不帶任何文字。
const FLASH_OK = { created: '已新增客戶', saved: '已儲存', enabled: '已啟用', disabled: '已停用', deleted: '已刪除' };
const FLASH_ERR = { notfound: '找不到指定的客戶', inuse: '這個客戶底下已經有設備，不能刪除，只能停用' };

const parseId = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

function render(req, res, { error = null, form = null, editId = null, status = 200 } = {}) {
  res.status(status).render('admin/customers', {
    customers: Customer.findAll(),
    form: form || { name: '', code: '', notes: '' },
    editId,
    max: { name: Customer.MAX_NAME, code: Customer.MAX_CODE, notes: Customer.MAX_NOTES },
    ok: FLASH_OK[req.query.ok] || null,
    error: error || FLASH_ERR[req.query.err] || null,
  });
}

router.get('/', (req, res) => {
  const id = parseId(req.query.edit);
  const c = id ? Customer.findById(id) : null;
  render(req, res, c ? { editId: c.id, form: { name: c.name, code: c.code || '', notes: c.notes || '' } } : {});
});

router.post('/', (req, res) => {
  const v = Customer.validate(req.body);
  if (v.error) return render(req, res, { error: v.error, form: req.body, status: 400 });
  const c = Customer.create(v.value);
  console.log(`[客戶] ${req.user.username} 新增客戶「${c.name}」`);
  res.redirect('/admin/customers?ok=created');
});

function load(req, res) {
  const c = Customer.findById(parseId(req.params.id));
  if (!c) { res.redirect('/admin/customers?err=notfound'); return null; }
  return c;
}

router.post('/:id', (req, res) => {
  const c = load(req, res);
  if (!c) return;
  const v = Customer.validate(req.body, c.id);
  if (v.error) return render(req, res, { error: v.error, form: req.body, editId: c.id, status: 400 });
  Customer.update(c.id, v.value);
  console.log(`[客戶] ${req.user.username} 修改客戶「${c.name}」→「${v.value.name}」`);
  res.redirect('/admin/customers?ok=saved');
});

router.post('/:id/toggle', (req, res) => {
  const c = load(req, res);
  if (!c) return;
  Customer.setActive(c.id, !c.is_active);
  res.redirect(`/admin/customers?ok=${c.is_active ? 'disabled' : 'enabled'}`);
});

router.post('/:id/delete', (req, res) => {
  const c = load(req, res);
  if (!c) return;
  if (!Customer.remove(c.id)) return res.redirect('/admin/customers?err=inuse');
  console.log(`[客戶] ${req.user.username} 刪除客戶「${c.name}」`);
  res.redirect('/admin/customers?ok=deleted');
});

module.exports = router;
