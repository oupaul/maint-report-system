const express = require('express');
const router = express.Router();

const { requireLogin, requireRole } = require('../middleware/auth');
const Asset = require('../models/Asset');
const { ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, isValidCategory } = require('../utils/validators');

router.get('/', requireLogin, (req, res) => {
  const assets = Asset.findAll({ includeInactive: true });
  res.render('assets/list', { assets, categoryLabels: ASSET_CATEGORY_LABELS });
});

router.get('/new', requireRole('admin'), (req, res) => {
  res.render('assets/form', {
    asset: null,
    categories: ASSET_CATEGORIES,
    categoryLabels: ASSET_CATEGORY_LABELS,
    error: null,
  });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, category, location, identifier, notes } = req.body;

  if (!name || !isValidCategory(category)) {
    return res.status(400).render('assets/form', {
      asset: req.body,
      categories: ASSET_CATEGORIES,
      categoryLabels: ASSET_CATEGORY_LABELS,
      error: '請輸入資產名稱並選擇有效的類別',
    });
  }

  const asset = Asset.create({ name, category, location, identifier, notes });
  res.redirect(`/assets/${asset.id}/edit`);
});

router.get('/:id/edit', requireRole('admin'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }
  res.render('assets/form', {
    asset,
    categories: ASSET_CATEGORIES,
    categoryLabels: ASSET_CATEGORY_LABELS,
    error: null,
  });
});

router.post('/:id/edit', requireRole('admin'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }

  const { name, category, location, identifier, notes, is_active } = req.body;

  if (!name || !isValidCategory(category)) {
    return res.status(400).render('assets/form', {
      asset: { ...asset, ...req.body },
      categories: ASSET_CATEGORIES,
      categoryLabels: ASSET_CATEGORY_LABELS,
      error: '請輸入資產名稱並選擇有效的類別',
    });
  }

  Asset.update(asset.id, {
    name, category, location, identifier, notes,
    is_active: is_active === 'on' || is_active === '1',
  });

  res.redirect('/assets');
});

module.exports = router;
