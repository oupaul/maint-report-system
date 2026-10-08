const express = require('express');
const router = express.Router();

const AssetCategory = require('../models/AssetCategory');
const ChecklistItem = require('../models/ChecklistItem');

// 掛在 /admin/categories 底下，上層（routes/admin.js）已經限定管理員、並帶入 fmt。
// 網址只帶固定代碼與數字，不帶任何文字，避免做出一個網址讓管理員頁面顯示任意內容。
const FLASH_OK = {
  created: '已新增類型',
  renamed: '已更新名稱',
  enabled: '已啟用',
  disabled: '已停用',
  deleted: '已刪除',
  moved: '已調整排序',
  added: '已新增檢查項目',
  copied: '已複製檢查項目',
};
const FLASH_ERR = {
  notfound: '找不到指定的項目',
  inuse: '這個類型底下已經有設備或檢查紀錄，不能刪除，只能停用',
  itemused: '這個檢查項目已經有檢查紀錄，不能刪除，只能停用（舊報告會繼續顯示它）',
  nocopy: '沒有可複製的檢查項目（來源類型沒有啟用中的項目，或項目名稱都已存在）',
};

function flash(req) {
  const n = parseInt(req.query.n, 10);
  const ok = FLASH_OK[req.query.ok];
  return {
    ok: ok ? (req.query.ok === 'copied' && n >= 0 ? `${ok}（新增 ${n} 項）` : ok) : null,
    err: FLASH_ERR[req.query.err] || null,
  };
}

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---- 類型清單 ----

function renderList(req, res, { error = null, formLabel = '', status = 200 } = {}) {
  const categories = AssetCategory.findAll().map(c => ({ ...c, usage: AssetCategory.usage(c), deletable: false }));
  categories.forEach(c => { c.deletable = c.usage.assets === 0 && c.usage.records === 0; });
  const f = flash(req);
  res.status(status).render('admin/categories', {
    categories,
    maxLabel: AssetCategory.MAX_LABEL,
    formLabel,
    ok: f.ok,
    error: error || f.err,
  });
}

router.get('/', (req, res) => renderList(req, res));

router.post('/', (req, res) => {
  const label = req.body.label;
  const error = AssetCategory.validateLabel(label);
  if (error) return renderList(req, res, { error, formLabel: label || '', status: 400 });
  let copyFrom = null;
  if (req.body.copy_from) {
    const src = AssetCategory.findByCode(req.body.copy_from);
    if (src) copyFrom = src.code;
  }
  const created = AssetCategory.create(label, { copyFromCode: copyFrom });
  console.log(`[設備類型] ${req.user.username} 新增類型「${created.label}」${copyFrom ? `（複製 ${copyFrom} 的檢查項目）` : ''}`);
  res.redirect(`/admin/categories/${created.id}?ok=created`);
});

// ---- 單一類型（名稱、檢查項目）----

function loadCategory(req, res) {
  const category = AssetCategory.findById(parseId(req.params.id));
  if (!category) {
    res.redirect('/admin/categories?err=notfound');
    return null;
  }
  return category;
}

function renderDetail(req, res, category, { error = null, itemError = null, form = {}, status = 200 } = {}) {
  const items = ChecklistItem.findByCategory(category.code, { includeInactive: true })
    .map(i => ({ ...i, records: ChecklistItem.recordCount(i.id) }));
  const f = flash(req);
  res.status(status).render('admin/category', {
    category,
    usage: AssetCategory.usage(category),
    deletable: AssetCategory.canDelete(category),
    items,
    otherCategories: AssetCategory.findAll().filter(c => c.id !== category.id),
    maxLabel: AssetCategory.MAX_LABEL,
    maxItemLabel: ChecklistItem.MAX_LABEL,
    form,
    ok: f.ok,
    error: error || f.err,
    itemError,
  });
}

router.get('/:id', (req, res) => {
  const category = loadCategory(req, res);
  if (category) renderDetail(req, res, category);
});

router.post('/:id/rename', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const error = AssetCategory.validateLabel(req.body.label, category.id);
  if (error) return renderDetail(req, res, category, { error, form: { label: req.body.label }, status: 400 });
  AssetCategory.rename(category.id, req.body.label);
  res.redirect(`/admin/categories/${category.id}?ok=renamed`);
});

router.post('/:id/move', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  AssetCategory.move(category.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/categories?ok=moved');
});

router.post('/:id/toggle', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const enable = !category.is_active;
  AssetCategory.setActive(category.id, enable);
  console.log(`[設備類型] ${req.user.username} ${enable ? '啟用' : '停用'}類型「${category.label}」`);
  res.redirect(`/admin/categories?ok=${enable ? 'enabled' : 'disabled'}`);
});

router.post('/:id/delete', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  if (!AssetCategory.remove(category.id)) return res.redirect('/admin/categories?err=inuse');
  console.log(`[設備類型] ${req.user.username} 刪除類型「${category.label}」`);
  res.redirect('/admin/categories?ok=deleted');
});

// ---- 檢查項目 ----

router.post('/:id/items', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const itemError = ChecklistItem.validateLabel(category.code, req.body.label);
  if (itemError) return renderDetail(req, res, category, { itemError, form: { itemLabel: req.body.label }, status: 400 });
  ChecklistItem.create(category.code, req.body.label);
  res.redirect(`/admin/categories/${category.id}?ok=added`);
});

router.post('/:id/items/copy', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const src = AssetCategory.findByCode(req.body.copy_from);
  if (!src || src.code === category.code) return res.redirect(`/admin/categories/${category.id}?err=notfound`);
  const added = ChecklistItem.copyAll(src.code, category.code);
  if (added === 0) return res.redirect(`/admin/categories/${category.id}?err=nocopy`);
  res.redirect(`/admin/categories/${category.id}?ok=copied&n=${added}`);
});

function loadItem(req, res, category) {
  const item = ChecklistItem.findById(parseId(req.params.itemId));
  if (!item || item.category !== category.code) {
    res.redirect(`/admin/categories/${category.id}?err=notfound`);
    return null;
  }
  return item;
}

router.post('/:id/items/:itemId/rename', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const item = loadItem(req, res, category);
  if (!item) return;
  const itemError = ChecklistItem.validateLabel(category.code, req.body.label, item.id);
  if (itemError) return renderDetail(req, res, category, { itemError, status: 400 });
  ChecklistItem.rename(item.id, req.body.label);
  res.redirect(`/admin/categories/${category.id}?ok=renamed`);
});

router.post('/:id/items/:itemId/move', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const item = loadItem(req, res, category);
  if (!item) return;
  ChecklistItem.move(item.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect(`/admin/categories/${category.id}?ok=moved`);
});

router.post('/:id/items/:itemId/toggle', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const item = loadItem(req, res, category);
  if (!item) return;
  const enable = !item.is_active;
  ChecklistItem.setActive(item.id, enable);
  res.redirect(`/admin/categories/${category.id}?ok=${enable ? 'enabled' : 'disabled'}`);
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const category = loadCategory(req, res);
  if (!category) return;
  const item = loadItem(req, res, category);
  if (!item) return;
  if (!ChecklistItem.remove(item.id)) return res.redirect(`/admin/categories/${category.id}?err=itemused`);
  res.redirect(`/admin/categories/${category.id}?ok=deleted`);
});

module.exports = router;
