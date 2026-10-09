const express = require('express');
const router = express.Router();

const multer = require('multer');
const Customer = require('../models/Customer');
const CustomerCsvService = require('../services/CustomerCsvService');
const AssetCsvService = require('../services/AssetCsvService');
const csv = require('../utils/csv');

// 掛在 /admin/customers（routes/admin.js 以「管理資產建檔」權限保護）。網址只帶固定代碼，不帶任何文字。
const FLASH_OK = { created: '已新增客戶', saved: '已儲存', enabled: '已啟用', disabled: '已停用', deleted: '已刪除' };
const FLASH_ERR = { notfound: '找不到指定的客戶', inuse: '這個客戶底下已經有設備，不能刪除，只能停用' };

const parseId = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

function render(req, res, { error = null, form = null, editId = null, status = 200 } = {}) {
  res.status(status).render('admin/customers', {
    customers: Customer.findAll(),
    form: form || { name: '', code: '', notes: '', tax_id: '' },
    editId,
    max: { name: Customer.MAX_NAME, code: Customer.MAX_CODE, notes: Customer.MAX_NOTES },
    ok: FLASH_OK[req.query.ok] || null,
    error: error || FLASH_ERR[req.query.err] || null,
  });
}

router.get('/', (req, res) => {
  const id = parseId(req.query.edit);
  const c = id ? Customer.findById(id) : null;
  render(req, res, c ? { editId: c.id, form: { name: c.name, code: c.code || '', notes: c.notes || '', tax_id: c.tax_id || '' } } : {});
});

router.post('/', (req, res) => {
  const v = Customer.validate(req.body);
  if (v.error) return render(req, res, { error: v.error, form: req.body, status: 400 });
  const c = Customer.create(v.value);
  console.log(`[客戶] ${req.user.username} 新增客戶「${c.name}」`);
  res.redirect('/admin/customers?ok=created');
});

// ---- CSV 匯出／匯入（要放在 /:id 之前）----
router.get('/export.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.send(CustomerCsvService.exportCsv());
});
router.get('/import-template.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="customers-import-template.csv"' });
  res.send(CustomerCsvService.templateCsv());
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

function renderImport(res, extra = {}) {
  res.status(extra.status || 200).render('admin/customers-import', {
    maxRows: CustomerCsvService.MAX_ROWS, error: null, preview: null, result: null, token: null, filename: '', encoding: '', ...extra,
  });
}

router.get('/import', (req, res) => renderImport(res));

// 上傳（multipart：CSRF token 在網址 ?_csrf=）→ 解析、規劃、顯示預覽（還沒寫入任何資料）
router.post('/import', (req, res, next) => {
  csvUpload.single('file')(req, res, (err) => {
    if (err) return renderImport(res, { status: 400, error: err.code === 'LIMIT_FILE_SIZE' ? '檔案太大（上限 1MB）' : '上傳失敗，請再試一次' });
    if (!req.file) return renderImport(res, { status: 400, error: '請選擇要上傳的 CSV 檔案' });
    try {
      const { text, encoding } = csv.decodeCsv(req.file.buffer);
      const table = csv.parseCsv(text, { maxRows: CustomerCsvService.MAX_ROWS + 200 });
      const preview = CustomerCsvService.plan(table);
      const filename = Buffer.from(req.file.originalname || '', 'latin1').toString('utf8').slice(0, 100);
      const token = preview.fileErrors.length ? null : AssetCsvService.savePending(req.user.id, { table, filename, encoding }, 'customers');
      renderImport(res, { preview, token, filename, encoding });
    } catch (e) {
      if (e.userFacing) return renderImport(res, { status: 400, error: e.message });
      next(e);
    }
  });
});

// 確認匯入：用保存的資料重新規劃一次（預覽之後資料可能又變了），只寫有效的列
router.post('/import/confirm', (req, res, next) => {
  try {
    const pending = AssetCsvService.getPending(req.user.id, req.body.token, 'customers');
    if (!pending) return renderImport(res, { status: 400, error: '預覽已經過期（或已經匯入過了），請重新上傳檔案' });
    const planResult = CustomerCsvService.plan(pending.table);
    if (planResult.fileErrors.length) return renderImport(res, { status: 400, error: planResult.fileErrors.join('；') });
    const done = CustomerCsvService.apply(planResult);
    AssetCsvService.dropPending(req.body.token);
    console.log(`[客戶匯入] ${req.user.username} 匯入「${pending.filename}」：新增 ${done.created}、更新 ${done.updated}、略過錯誤 ${planResult.summary.error}`);
    renderImport(res, { result: { ...done, skipped: planResult.summary.error, unchanged: planResult.summary.unchanged } });
  } catch (e) {
    next(e);
  }
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
