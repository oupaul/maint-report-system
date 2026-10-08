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
const User = require('../models/User');
const ChecklistItem = require('../models/ChecklistItem');
const Asset = require('../models/Asset');
const ImageService = require('../services/ImageService');
const ApprovalService = require('../services/ApprovalService');
const statusColors = require('../utils/statusColors');
const AssetCategory = require('../models/AssetCategory');
const {
  ITEM_STATUSES, isValidStatus,
  SIGNATURE_ROLES, SIGNATURE_ROLE_LABELS, isValidSignatureRole,
} = require('../utils/validators');
const config = require('../config');

// 簽核流程開關（entry/list 頁面要用來決定顯示「標記為已完成」還是「送出審核」）
router.use((req, res, next) => {
  res.locals.approvalEnabled = ApprovalService.isEnabled();
  next();
});

// 審核中與已核准的批次鎖定：伺服器端一律擋下（不只是把按鈕藏起來）
function rejectIfLocked(res, batch) {
  if (!ApprovalService.isLocked(batch)) return false;
  res.status(409).render('error', {
    title: '批次已鎖定',
    message: batch.approval_status === 'pending'
      ? '這個批次正在審核中，不能編輯。如需修改，請由送審的人或管理員先「撤回審核」。'
      : '這個批次已經核准，不能編輯。如需修改，請由管理員「重新開啟」。',
  });
  return true;
}

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll().map(b => ({ ...b, statusInfo: ApprovalService.statusInfo(b), locked: ApprovalService.isLocked(b) }));
  res.render('batches/list', { batches });
});

router.get('/new', requireLogin, (req, res) => {
  const assets = Asset.findAll();
  res.render('batches/new', {
    assets,
    categories: AssetCategory.selectableCodes(),
    categoryLabels: AssetCategory.labelMap(),
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
    if (!name || !AssetCategory.isSelectable(category)) continue; // 空白列直接跳過，不當成錯誤
    const asset = Asset.create({ name, category, location: (newLocations[i] || '').trim() });
    createdAssetIds.push(asset.id);
  }

  const allAssetIds = [...assetIds, ...createdAssetIds];

  if (!title || !batch_date || allAssetIds.length === 0) {
    const assets = Asset.findAll();
    return res.status(400).render('batches/new', {
      assets,
      categories: AssetCategory.selectableCodes(),
      categoryLabels: AssetCategory.labelMap(),
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
    // 啟用中的項目一定列出；已停用的項目只有「這個設備在這個批次已經有紀錄」時才列出（資料不能憑空消失）
    const checklistItems = ChecklistItem.findByCategory(asset.category, { includeInactive: true })
      .filter(ci => ci.is_active || itemsByAssetAndChecklist.has(`${asset.id}:${ci.id}`));
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
  const pre = InspectionBatch.findById(req.params.id);
  if (pre && ApprovalService.isLocked(pre)) return res.redirect(`/batches/${pre.id}?msg=locked`);
  const data = buildEntryData(req.params.id);
  if (!data) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }
  res.render('batches/entry', {
    batch: data.batch,
    assetSections: data.assetSections,
    availableAssets: data.availableAssets,
    categories: AssetCategory.selectableCodes(),
    categoryLabels: AssetCategory.labelMap(),
    statuses: ITEM_STATUSES,
    statusColors,
    addAssetError: null,
    returnNote: ApprovalService.lastReturnNote(data.batch),
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
  if (rejectIfLocked(res, batch)) return;

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
    if (!name || !AssetCategory.isSelectable(category)) continue;
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
      categories: AssetCategory.selectableCodes(),
      categoryLabels: AssetCategory.labelMap(),
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

router.post('/:id/items/:checklistItemId', requireLogin, upload.array('screenshots', 10), async (req, res, next) => {
  try {
    const batch = InspectionBatch.findById(req.params.id);
    if (!batch) {
      return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
    }
    if (rejectIfLocked(res, batch)) return;

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
        let result;
        try {
          result = await ImageService.processScreenshot(file.buffer, file.mimetype, destPath);
        } catch (err) {
          // 這張處理失敗：清掉佔位列，並告訴使用者是「哪一個檔案」的問題（前面已處理成功的檔案會保留）
          InspectionItemPhoto.remove(photo.id);
          if (err.userFacing) {
            return res.status(400).render('error', {
              title: '圖片上傳失敗',
              message: `「${upload.decodeFilename(file.originalname)}」：${err.message}`,
            });
          }
          throw err;
        }
        InspectionItemPhoto.updateFile(photo.id, result);
      }
    }

    res.redirect(`/batches/${batch.id}/entry`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/photos/:photoId/delete', requireLogin, (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }
  if (rejectIfLocked(res, batch)) return;

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
  // 啟用簽核流程後，批次只能「送出審核」並經核准才算完成，不能自己直接標記完成
  if (ApprovalService.isEnabled()) {
    return res.status(400).render('error', {
      title: '請改用送出審核',
      message: '已啟用簽核流程，批次要「送出審核」並通過簽核才算完成。',
    });
  }
  if (rejectIfLocked(res, batch)) return;
  InspectionBatch.complete(batch.id);
  res.redirect(`/batches/${batch.id}`);
});

// ---- 簽核動作 ----

function approvalFailure(res, result) {
  return res.status(result.status || 400).render('error', { title: '無法完成這個動作', message: result.error });
}

router.post('/:id/submit', requireLogin, (req, res) => {
  const result = ApprovalService.submit(parseInt(req.params.id, 10), req.user, req.body.comment);
  if (!result.ok) return approvalFailure(res, result);
  console.log(`[簽核] ${req.user.username} 送出批次 #${req.params.id} 審核`);
  res.redirect(`/batches/${req.params.id}?ok=submitted`);
});

router.post('/:id/approve', requireLogin, (req, res) => {
  const result = ApprovalService.approve(parseInt(req.params.id, 10), req.user, req.body.comment);
  if (!result.ok) return approvalFailure(res, result);
  console.log(`[簽核] ${req.user.username} 核准批次 #${req.params.id}（${result.outcome}）`);
  res.redirect(`/batches/${req.params.id}?ok=${result.outcome === 'approved' ? 'approved' : 'next'}`);
});

router.post('/:id/return', requireLogin, (req, res) => {
  const result = ApprovalService.returnBatch(parseInt(req.params.id, 10), req.user, req.body.comment);
  if (!result.ok) return approvalFailure(res, result);
  console.log(`[簽核] ${req.user.username} 退回批次 #${req.params.id}`);
  res.redirect(`/batches/${req.params.id}?ok=returned`);
});

router.post('/:id/withdraw', requireLogin, (req, res) => {
  const result = ApprovalService.withdraw(parseInt(req.params.id, 10), req.user);
  if (!result.ok) return approvalFailure(res, result);
  console.log(`[簽核] ${req.user.username} 撤回批次 #${req.params.id} 的審核`);
  res.redirect(`/batches/${req.params.id}?ok=withdrawn`);
});

router.post('/:id/reopen', requireLogin, (req, res) => {
  const result = ApprovalService.reopen(parseInt(req.params.id, 10), req.user, req.body.comment);
  if (!result.ok) return approvalFailure(res, result);
  console.log(`[簽核] ${req.user.username} 重新開啟批次 #${req.params.id}`);
  res.redirect(`/batches/${req.params.id}?ok=reopened`);
});

const APPROVAL_FLASH = {
  submitted: '已送出審核，批次已鎖定，等待簽核。',
  next: '已核准這一關，已通知下一關的簽核人。',
  approved: '已核准，批次完成，所有簽核關卡都已通過。',
  returned: '已退回，並通知送審的人修改。',
  withdrawn: '已撤回審核，批次可以重新編輯。',
  reopened: '已重新開啟，批次可以重新編輯，修改後需要重新送出審核。',
};

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

  const record = ApprovalService.currentRecord(batch);
  const showApproval = ApprovalService.isEnabled() || batch.approval_status !== 'none';
  const approval = {
    show: showApproval,
    status: ApprovalService.statusInfo(batch),
    locked: ApprovalService.isLocked(batch),
    history: ApprovalService.history(batch),
    canSubmit: ApprovalService.canSubmit(batch),
    canWithdraw: ApprovalService.canWithdraw(req.user, batch),
    canReopen: ApprovalService.canReopen(req.user, batch),
    current: record ? {
      record,
      canAct: ApprovalService.canAct(req.user, batch, record),
      approverNames: ApprovalService.approversOf(record, batch).map(u => u.display_name || u.username),
    } : null,
    submittedByName: batch.submitted_by ? ((User.findById(batch.submitted_by) || {}).display_name || (User.findById(batch.submitted_by) || {}).username) : null,
    flash: APPROVAL_FLASH[req.query.ok] || null,
    notice: req.query.msg === 'locked' ? '審核中或已核准的批次不能編輯。如需修改，請先撤回審核（送審的人或管理員），或由管理員重新開啟。' : null,
    maxComment: ApprovalService.MAX_COMMENT,
  };

  res.render('batches/show', {
    approval,
    batch,
    assets,
    itemsByAssetId,
    categoryLabels: AssetCategory.labelMap(),
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

  if (batch.approval_status === 'approved') {
    return res.status(409).render('error', { title: '批次已鎖定', message: '這個批次已經核准，不能再修改簽名。如需修改，請由管理員「重新開啟」。' });
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
