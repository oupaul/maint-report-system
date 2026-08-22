const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const InspectionBatch = require('../models/InspectionBatch');
const InspectionItem = require('../models/InspectionItem');
const InspectionItemPhoto = require('../models/InspectionItemPhoto');
const BatchSignature = require('../models/BatchSignature');
const ChecklistItem = require('../models/ChecklistItem');
const Asset = require('../models/Asset');
const ImageService = require('../services/ImageService');
const statusColors = require('../utils/statusColors');
const {
  ASSET_CATEGORIES, ASSET_CATEGORY_LABELS, ITEM_STATUSES, isValidStatus, isValidCategory,
  SIGNATURE_ROLES, SIGNATURE_ROLE_LABELS, isValidSignatureRole,
} = require('../utils/validators');
const config = require('../config');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll();
  res.render('batches/list', { batches });
});

router.get('/new', requireLogin, (req, res) => {
  const assets = Asset.findAll();
  res.render('batches/new', {
    assets,
    categories: ASSET_CATEGORIES,
    categoryLabels: ASSET_CATEGORY_LABELS,
    error: null,
    formValues: null,
  });
});

// 這個系統的核心用途是產生巡檢報告，不是資產管理系統——設備清單不強制先到
// 「資產管理」建檔才能用，這裡可以直接一次輸入新設備。內部仍然寫進 assets
// 表（保留設備跨批次的歷史記錄可以查），只是不再是必要的前置步驟。
router.post('/new', requireLogin, (req, res) => {
  const { title, batch_date, notes } = req.body;
  let assetIds = req.body.asset_ids || [];
  if (!Array.isArray(assetIds)) assetIds = [assetIds];
  assetIds = assetIds.filter(Boolean).map(id => parseInt(id, 10));

  let newNames = req.body.new_asset_name || [];
  let newCategories = req.body.new_asset_category || [];
  let newLocations = req.body.new_asset_location || [];
  if (!Array.isArray(newNames)) newNames = [newNames];
  if (!Array.isArray(newCategories)) newCategories = [newCategories];
  if (!Array.isArray(newLocations)) newLocations = [newLocations];

  const createdAssetIds = [];
  for (let i = 0; i < newNames.length; i++) {
    const name = (newNames[i] || '').trim();
    const category = newCategories[i];
    if (!name || !isValidCategory(category)) continue; // 空白列直接跳過，不當成錯誤
    const asset = Asset.create({ name, category, location: (newLocations[i] || '').trim() });
    createdAssetIds.push(asset.id);
  }

  const allAssetIds = [...assetIds, ...createdAssetIds];

  if (!title || !batch_date || allAssetIds.length === 0) {
    const assets = Asset.findAll();
    return res.status(400).render('batches/new', {
      assets,
      categories: ASSET_CATEGORIES,
      categoryLabels: ASSET_CATEGORY_LABELS,
      error: '請輸入標題、日期，並至少新增或勾選一項設備',
      formValues: req.body,
    });
  }

  const batch = InspectionBatch.create({
    title,
    batch_date,
    created_by: req.user.id,
    notes,
  });

  for (const assetId of allAssetIds) {
    InspectionBatch.addAsset(batch.id, assetId);
  }

  res.redirect(`/batches/${batch.id}/entry`);
});

function buildEntryData(batchId) {
  const batch = InspectionBatch.findById(batchId);
  if (!batch) return null;

  const assets = InspectionBatch.getAssets(batchId);
  const assetIdsInBatch = new Set(assets.map(a => a.id));
  const availableAssets = Asset.findAll().filter(a => !assetIdsInBatch.has(a.id));
  const existingItems = InspectionItem.findByBatch(batchId);

  const photosByItemId = InspectionItemPhoto.findByItemIds(existingItems.map(i => i.id));

  const itemsByAssetAndChecklist = new Map();
  for (const item of existingItems) {
    itemsByAssetAndChecklist.set(`${item.asset_id}:${item.checklist_item_id}`, item);
  }

  const assetSections = assets.map(asset => {
    const checklistItems = ChecklistItem.findByCategory(asset.category);
    const rows = checklistItems.map(ci => {
      const existing = itemsByAssetAndChecklist.get(`${asset.id}:${ci.id}`);
      const photos = existing ? (photosByItemId.get(existing.id) || []) : [];
      return {
        checklistItem: ci,
        existing: existing || null,
        photos: photos.map(p => ({ ...p, filename: path.basename(p.path) })),
      };
    });
    return { asset, rows };
  });

  return { batch, assetSections, availableAssets };
}

router.get('/:id/entry', requireLogin, (req, res) => {
  const data = buildEntryData(req.params.id);
  if (!data) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }
  res.render('batches/entry', {
    batch: data.batch,
    assetSections: data.assetSections,
    availableAssets: data.availableAssets,
    categories: ASSET_CATEGORIES,
    categoryLabels: ASSET_CATEGORY_LABELS,
    statuses: ITEM_STATUSES,
    statusColors,
    addAssetError: null,
  });
});

// 建立批次當下只是「先選一批」，巡檢途中常常需要臨時加一台漏掉的設備——
// 不強制回到列表頁重開一個新批次，直接在填寫頁加進同一批次即可。跟
// POST /batches/new 共用同一套「勾選既有 / 快速新增」邏輯。
router.post('/:id/assets', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  let assetIds = req.body.asset_ids || [];
  if (!Array.isArray(assetIds)) assetIds = [assetIds];
  assetIds = assetIds.filter(Boolean).map(id => parseInt(id, 10));

  let newNames = req.body.new_asset_name || [];
  let newCategories = req.body.new_asset_category || [];
  let newLocations = req.body.new_asset_location || [];
  if (!Array.isArray(newNames)) newNames = [newNames];
  if (!Array.isArray(newCategories)) newCategories = [newCategories];
  if (!Array.isArray(newLocations)) newLocations = [newLocations];

  const createdAssetIds = [];
  for (let i = 0; i < newNames.length; i++) {
    const name = (newNames[i] || '').trim();
    const category = newCategories[i];
    if (!name || !isValidCategory(category)) continue;
    const asset = Asset.create({ name, category, location: (newLocations[i] || '').trim() });
    createdAssetIds.push(asset.id);
  }

  const allAssetIds = [...assetIds, ...createdAssetIds];

  if (allAssetIds.length === 0) {
    const data = buildEntryData(batch.id);
    return res.status(400).render('batches/entry', {
      batch: data.batch,
      assetSections: data.assetSections,
      availableAssets: data.availableAssets,
      categories: ASSET_CATEGORIES,
      categoryLabels: ASSET_CATEGORY_LABELS,
      statuses: ITEM_STATUSES,
      statusColors,
      addAssetError: '請至少新增或勾選一項設備',
    });
  }

  for (const assetId of allAssetIds) {
    InspectionBatch.addAsset(batch.id, assetId);
  }

  res.redirect(`/batches/${batch.id}/entry`);
});

router.post('/:id/items/:checklistItemId', requireLogin, upload.array('screenshots', 10), async (req, res) => {
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

  const item = InspectionItem.upsert({
    batch_id: batch.id,
    asset_id: asset.id,
    checklist_item_id: checklistItem.id,
    status,
    value_text: req.body.value_text,
    note: req.body.note,
    source: 'manual',
    recorded_by: req.user.id,
  });

  // 每張照片先插入佔位列取得 id（檔名需要用到），轉檔完成後再回填實際路徑/尺寸
  if (req.files && req.files.length > 0) {
    const existingCount = InspectionItemPhoto.findByItemId(item.id).length;
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const photo = InspectionItemPhoto.create({ inspection_item_id: item.id, sort_order: existingCount + i });
      const destPath = path.join(config.UPLOADS_DIR, String(batch.id), `${asset.id}-${checklistItem.id}-${photo.id}`);
      const result = await ImageService.processScreenshot(file.buffer, file.mimetype, destPath);
      InspectionItemPhoto.updateFile(photo.id, result);
    }
  }

  res.redirect(`/batches/${batch.id}/entry`);
});

router.post('/:id/photos/:photoId/delete', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  const photo = InspectionItemPhoto.findById(req.params.photoId);
  if (photo && photo.path) {
    try {
      fs.unlinkSync(photo.path);
    } catch (err) {
      // 檔案可能已經不存在，不影響刪除這筆紀錄
    }
    InspectionItemPhoto.remove(photo.id);
  }

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
  const photosByItemId = InspectionItemPhoto.findByItemIds(items.map(i => i.id));

  const itemsByAssetId = new Map();
  for (const item of items) {
    const photos = photosByItemId.get(item.id) || [];
    item.photos = photos.map(p => ({ ...p, filename: path.basename(p.path) }));
    if (!itemsByAssetId.has(item.asset_id)) itemsByAssetId.set(item.asset_id, []);
    itemsByAssetId.get(item.asset_id).push(item);
  }

  const signatures = BatchSignature.findByBatchId(batch.id);
  const signaturesByRole = {};
  for (const sig of signatures) {
    signaturesByRole[sig.role] = { ...sig, filename: path.basename(sig.signature_path) };
  }

  res.render('batches/show', {
    batch,
    assets,
    itemsByAssetId,
    categoryLabels: ASSET_CATEGORY_LABELS,
    statusColors,
    signatureRoles: SIGNATURE_ROLES,
    signatureRoleLabels: SIGNATURE_ROLE_LABELS,
    signaturesByRole,
  });
});

// 簽名畫布送出的是 canvas.toDataURL() 產生的 base64 PNG（data:image/png;base64,....），
// 簽署者一律用目前登入帳號，不開放自由填名——簽名紀錄才有稽核意義。
router.post('/:id/signatures/:role', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  const role = req.params.role;
  if (!isValidSignatureRole(role)) {
    return res.status(400).render('error', { title: '無效的簽名角色', message: '無效的簽名角色' });
  }

  // 主管簽核只開放給系統角色是 admin 的帳號，避免技術人員帳號自己簽自己的
  // 主管審核欄位、讓簽核失去稽核意義。工程師欄位任何登入帳號都能簽（本來就
  // 代表「執行巡檢的人」，沒有審核性質）。
  if (role === 'supervisor' && req.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: '權限不足',
      message: '主管簽核僅限管理員帳號，請聯絡管理員協助簽署',
    });
  }

  const dataUrl = req.body.signature_data || '';
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return res.status(400).render('error', { title: '無效的簽名資料', message: '請先在畫布上簽名再送出' });
  }

  const buffer = Buffer.from(match[1], 'base64');
  const destPath = path.join(config.UPLOADS_DIR, String(batch.id), `signature-${role}.png`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);

  BatchSignature.upsert({
    batch_id: batch.id,
    role,
    user_id: req.user.id,
    signature_path: destPath,
  });

  res.redirect(`/batches/${batch.id}`);
});

module.exports = router;
