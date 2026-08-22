const express = require('express');
const path = require('path');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const InspectionBatch = require('../models/InspectionBatch');
const InspectionItem = require('../models/InspectionItem');
const ChecklistItem = require('../models/ChecklistItem');
const Asset = require('../models/Asset');
const ImageService = require('../services/ImageService');
const statusColors = require('../utils/statusColors');
const { ASSET_CATEGORY_LABELS, ITEM_STATUSES, isValidStatus } = require('../utils/validators');
const config = require('../config');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll();
  res.render('batches/list', { batches });
});

router.get('/new', requireLogin, (req, res) => {
  const assets = Asset.findAll();
  res.render('batches/new', {
    assets,
    categoryLabels: ASSET_CATEGORY_LABELS,
    error: null,
    formValues: null,
  });
});

router.post('/new', requireLogin, (req, res) => {
  const { title, batch_date, notes } = req.body;
  let assetIds = req.body.asset_ids || [];
  if (!Array.isArray(assetIds)) assetIds = [assetIds];
  assetIds = assetIds.filter(Boolean).map(id => parseInt(id, 10));

  if (!title || !batch_date || assetIds.length === 0) {
    const assets = Asset.findAll();
    return res.status(400).render('batches/new', {
      assets,
      categoryLabels: ASSET_CATEGORY_LABELS,
      error: '請輸入標題、日期，並至少選擇一項資產',
      formValues: req.body,
    });
  }

  const batch = InspectionBatch.create({
    title,
    batch_date,
    created_by: req.user.id,
    notes,
  });

  for (const assetId of assetIds) {
    InspectionBatch.addAsset(batch.id, assetId);
  }

  res.redirect(`/batches/${batch.id}/entry`);
});

function buildEntryData(batchId) {
  const batch = InspectionBatch.findById(batchId);
  if (!batch) return null;

  const assets = InspectionBatch.getAssets(batchId);
  const existingItems = InspectionItem.findByBatch(batchId);

  const itemsByAssetAndChecklist = new Map();
  for (const item of existingItems) {
    itemsByAssetAndChecklist.set(`${item.asset_id}:${item.checklist_item_id}`, item);
  }

  const assetSections = assets.map(asset => {
    const checklistItems = ChecklistItem.findByCategory(asset.category);
    const rows = checklistItems.map(ci => {
      const existing = itemsByAssetAndChecklist.get(`${asset.id}:${ci.id}`);
      const screenshotFilename = existing && existing.screenshot_path
        ? path.basename(existing.screenshot_path)
        : null;
      return {
        checklistItem: ci,
        existing: existing || null,
        screenshotFilename,
      };
    });
    return { asset, rows };
  });

  return { batch, assetSections };
}

router.get('/:id/entry', requireLogin, (req, res) => {
  const data = buildEntryData(req.params.id);
  if (!data) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }
  res.render('batches/entry', {
    batch: data.batch,
    assetSections: data.assetSections,
    categoryLabels: ASSET_CATEGORY_LABELS,
    statuses: ITEM_STATUSES,
    statusColors,
  });
});

router.post('/:id/items/:checklistItemId', requireLogin, upload.single('screenshot'), async (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  const checklistItem = ChecklistItem.findById(req.params.checklistItemId);
  if (!checklistItem) {
    return res.status(404).render('error', { title: '找不到檢查項目', message: '找不到指定的檢查項目' });
  }

  const assetId = parseInt(req.body.asset_id, 10);
  const asset = Asset.findById(assetId);
  if (!asset) {
    return res.status(400).render('error', { title: '無效的資產', message: '找不到指定的資產' });
  }

  const status = req.body.status;
  if (!isValidStatus(status)) {
    return res.redirect(`/batches/${batch.id}/entry`);
  }

  let screenshotFields = {};
  if (req.file) {
    const destPath = path.join(config.UPLOADS_DIR, String(batch.id), `${asset.id}-${checklistItem.id}`);
    const result = await ImageService.processScreenshot(req.file.buffer, req.file.mimetype, destPath);
    screenshotFields = {
      screenshot_path: result.path,
      screenshot_format: result.format,
      screenshot_width: result.width,
      screenshot_height: result.height,
    };
  }

  InspectionItem.upsert({
    batch_id: batch.id,
    asset_id: asset.id,
    checklist_item_id: checklistItem.id,
    status,
    value_text: req.body.value_text,
    note: req.body.note,
    ...screenshotFields,
    source: 'manual',
    recorded_by: req.user.id,
  });

  res.redirect(`/batches/${batch.id}/entry`);
});

router.post('/:id/complete', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }
  InspectionBatch.complete(batch.id);
  res.redirect(`/batches/${batch.id}`);
});

router.get('/:id', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  const assets = InspectionBatch.getAssets(batch.id);
  const items = InspectionItem.findByBatch(batch.id);

  const itemsByAssetId = new Map();
  for (const item of items) {
    item.screenshotFilename = item.screenshot_path ? path.basename(item.screenshot_path) : null;
    if (!itemsByAssetId.has(item.asset_id)) itemsByAssetId.set(item.asset_id, []);
    itemsByAssetId.get(item.asset_id).push(item);
  }

  res.render('batches/show', {
    batch,
    assets,
    itemsByAssetId,
    categoryLabels: ASSET_CATEGORY_LABELS,
    statusColors,
  });
});

module.exports = router;
