const express = require('express');
const router = express.Router();

// 類型下拉選單：啟用中的類型，加上這個設備目前正在用的類型（即使已停用也要保留，才不會一存檔就被改掉）
function formData(asset, error) {
  const current = asset && asset.id ? asset.category : null;
  return {
    asset,
    categories: AssetCategory.selectableCodes(current),
    categoryLabels: AssetCategory.labelMap(),
    categoryLocked: !!(asset && asset.id && Asset.hasRecords(asset.id)),
    error,
  };
}

const { requireLogin, requirePermission } = require('../middleware/auth');
const Asset = require('../models/Asset');
const AssetCategory = require('../models/AssetCategory');

router.get('/', requireLogin, (req, res) => {
  const assets = Asset.findAll({ includeInactive: true });
  res.render('assets/list', { assets, categoryLabels: AssetCategory.labelMap() });
});

router.get('/new', requirePermission('assets.manage'), (req, res) => {
  res.render('assets/form', formData(null, null));
});

router.post('/', requirePermission('assets.manage'), (req, res) => {
  const { name, category, location, identifier, notes } = req.body;

  if (!name || !AssetCategory.isSelectable(category)) {
    return res.status(400).render('assets/form', formData(req.body, '請輸入資產名稱並選擇有效的類別'));
  }

  const asset = Asset.create({ name, category, location, identifier, notes });
  res.redirect(`/assets/${asset.id}/edit`);
});

router.get('/:id/edit', requirePermission('assets.manage'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }
  res.render('assets/form', formData(asset, null));
});

router.post('/:id/edit', requirePermission('assets.manage'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }

  const { name, category, location, identifier, notes, is_active } = req.body;

  // 已有檢查紀錄的資產不能改類型（舊紀錄對應的是原本類型的檢查項目）；
  // 沒改類型的話，即使這個類型已被停用也允許（只是不讓新設備選到它）
  const categoryChanged = category !== asset.category;
  if (categoryChanged && Asset.hasRecords(asset.id)) {
    return res.status(400).render('assets/form', formData({ ...asset, ...req.body, category: asset.category }, '這個設備已經有檢查紀錄，不能變更類型'));
  }
  if (!name || !(categoryChanged ? AssetCategory.isSelectable(category) : !!AssetCategory.findByCode(category))) {
    return res.status(400).render('assets/form', formData({ ...asset, ...req.body }, '請輸入資產名稱並選擇有效的類別'));
  }

  Asset.update(asset.id, {
    name, category, location, identifier, notes,
    is_active: is_active === 'on' || is_active === '1',
  });

  res.redirect('/assets');
});

module.exports = router;
