const express = require('express');
const router = express.Router();

const AssetField = require('../models/AssetField');
const AssetCategory = require('../models/AssetCategory');

// 掛在 /admin/fields 底下（routes/admin.js 已限定「管理設備類型」權限）。
// 網址只帶固定代碼，不帶任何文字，避免做出一個網址讓管理頁面顯示任意內容。
const FLASH_OK = {
  created: '已新增欄位',
  updated: '已儲存',
  enabled: '已啟用',
  disabled: '已停用',
  deleted: '已刪除',
  moved: '已調整排序',
};
const FLASH_ERR = {
  notfound: '找不到指定的欄位',
  inuse: '這個欄位已經有設備填過資料，不能刪除，只能停用（資料會保留，重新啟用就會回來）',
};

function flash(req) {
  return { ok: FLASH_OK[req.query.ok] || null, err: FLASH_ERR[req.query.err] || null };
}

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : (v ? [v] : []);
}

function categoryNames(def, labelMap) {
  if (!def.categoryList) return '所有類別';
  return def.categoryList.map(c => labelMap[c] || c).join('、');
}

function renderList(req, res, { error = null, form = null, status = 200 } = {}) {
  const labelMap = AssetCategory.labelMap();
  const fields = AssetField.findAll().map(f => ({
    ...f,
    count: AssetField.valueCount(f.id),
    appliesText: categoryNames(f, labelMap),
  }));
  const f = flash(req);
  res.status(status).render('admin/fields', {
    fields,
    categories: AssetCategory.findAll(),
    types: AssetField.TYPES,
    limits: { label: AssetField.MAX_LABEL, fields: AssetField.MAX_FIELDS, options: AssetField.MAX_OPTIONS },
    form: form || { label: '', type: 'text', options: '', categories: [], show_in_list: false },
    ok: f.ok,
    error: error || f.err,
  });
}

// 驗證表單；成功回傳 { data }，失敗回傳 { error }
function readForm(body, { id = null, fixedType = null } = {}) {
  const labelError = AssetField.validateLabel(body.label, id);
  if (labelError) return { error: labelError };
  const type = fixedType || body.type;
  if (!AssetField.TYPES[type]) return { error: '請選擇資料類型' };
  let options = [];
  if (type === 'select') {
    const parsed = AssetField.parseOptions(body.options);
    if (parsed.error) return { error: parsed.error };
    options = parsed.list;
  }
  const allCodes = AssetCategory.findAll().map(c => c.code);
  return {
    data: {
      label: body.label,
      type,
      options,
      categoryCodes: AssetField.normalizeCategories(asArray(body.categories), allCodes),
      showInList: body.show_in_list === 'on' || body.show_in_list === '1',
    },
  };
}

function formFromBody(body) {
  return { label: body.label || '', type: body.type || 'text', options: body.options || '', categories: asArray(body.categories), show_in_list: body.show_in_list === 'on' };
}

router.get('/', (req, res) => renderList(req, res));

router.post('/', (req, res) => {
  if (AssetField.findAll().length >= AssetField.MAX_FIELDS) {
    return renderList(req, res, { error: `自訂欄位最多 ${AssetField.MAX_FIELDS} 個（可以停用用不到的欄位）`, form: formFromBody(req.body), status: 400 });
  }
  const r = readForm(req.body);
  if (r.error) return renderList(req, res, { error: r.error, form: formFromBody(req.body), status: 400 });
  const created = AssetField.create(r.data);
  console.log(`[資產欄位] ${req.user.username} 新增欄位「${created.label}」（${AssetField.TYPES[created.type]}）`);
  res.redirect('/admin/fields?ok=created');
});

function load(req, res) {
  const field = AssetField.findById(parseId(req.params.id));
  if (!field) {
    res.redirect('/admin/fields?err=notfound');
    return null;
  }
  return field;
}

function renderDetail(req, res, field, { error = null, form = null, status = 200 } = {}) {
  const count = AssetField.valueCount(field.id);
  const f = flash(req);
  res.status(status).render('admin/field', {
    field,
    count,
    categories: AssetCategory.findAll(),
    types: AssetField.TYPES,
    limits: { label: AssetField.MAX_LABEL },
    form: form || {
      label: field.label,
      type: field.type,
      options: field.optionList.join('\n'),
      categories: field.categoryList || [],
      show_in_list: !!field.show_in_list,
    },
    ok: f.ok,
    error: error || f.err,
  });
}

router.get('/:id', (req, res) => {
  const field = load(req, res);
  if (field) renderDetail(req, res, field);
});

router.post('/:id', (req, res) => {
  const field = load(req, res);
  if (!field) return;
  // 已經有人填過資料的欄位不能改資料類型（舊資料的格式會對不上）
  const used = AssetField.isUsed(field.id);
  const r = readForm(req.body, { id: field.id, fixedType: used ? field.type : null });
  if (r.error) return renderDetail(req, res, field, { error: r.error, form: { ...formFromBody(req.body), type: used ? field.type : req.body.type }, status: 400 });
  AssetField.update(field.id, r.data);
  console.log(`[資產欄位] ${req.user.username} 修改欄位「${r.data.label}」`);
  res.redirect(`/admin/fields/${field.id}?ok=updated`);
});

router.post('/:id/move', (req, res) => {
  const field = load(req, res);
  if (!field) return;
  AssetField.move(field.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/fields?ok=moved');
});

router.post('/:id/toggle', (req, res) => {
  const field = load(req, res);
  if (!field) return;
  const enable = !field.is_active;
  AssetField.setActive(field.id, enable);
  console.log(`[資產欄位] ${req.user.username} ${enable ? '啟用' : '停用'}欄位「${field.label}」`);
  res.redirect(`/admin/fields?ok=${enable ? 'enabled' : 'disabled'}`);
});

router.post('/:id/delete', (req, res) => {
  const field = load(req, res);
  if (!field) return;
  if (!AssetField.remove(field.id)) return res.redirect('/admin/fields?err=inuse');
  console.log(`[資產欄位] ${req.user.username} 刪除欄位「${field.label}」`);
  res.redirect('/admin/fields?ok=deleted');
});

module.exports = router;
