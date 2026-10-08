const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const InspectionBatch = require('../models/InspectionBatch');
const InspectionItem = require('../models/InspectionItem');
const InspectionItemPhoto = require('../models/InspectionItemPhoto');
const BatchSignature = require('../models/BatchSignature');
const PdfReportService = require('../services/PdfReportService');
const config = require('../config');

router.get('/batches/:id/report.pdf', requireLogin, async (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) {
    return res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
  }

  const assets = InspectionBatch.getAssets(batch.id);
  const items = InspectionItem.findByBatch(batch.id);
  const photosByItemId = InspectionItemPhoto.findByItemIds(items.map(i => i.id));

  const itemsByAssetId = new Map();
  for (const item of items) {
    item.photos = photosByItemId.get(item.id) || [];
    if (!itemsByAssetId.has(item.asset_id)) itemsByAssetId.set(item.asset_id, []);
    itemsByAssetId.get(item.asset_id).push(item);
  }

  const signatures = BatchSignature.findByBatchId(batch.id);
  const signaturesByRole = {};
  for (const sig of signatures) {
    signaturesByRole[sig.role] = sig;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="batch-${batch.id}-report.pdf"`);

  try {
    await PdfReportService.generateBatchReport({ batch, assets, itemsByAssetId, signaturesByRole }, res);
  } catch (err) {
    console.error('[reports] PDF 產生失敗:', err);
    if (!res.headersSent) {
      res.status(500).send('PDF 產生失敗');
    } else {
      // pdfkit 已經開始把資料寫進 res（例如已呼叫過 doc.addPage()），
      // 這時 header 早已送出、無法再改成 500，只能直接結束連線，
      // 避免用戶端卡在等待一個永遠不會 doc.end() 的回應。
      res.end();
    }
  }
});

// 認證後才能存取的截圖檔案（不走 express.static 公開掛載）
router.get('/uploads/:batchId/:filename', requireLogin, (req, res) => {
  const { batchId, filename } = req.params;

  // 防止路徑穿越
  if (filename.includes('..') || batchId.includes('..')) {
    return res.status(400).send('無效的檔案路徑');
  }

  const filePath = path.join(config.UPLOADS_DIR, batchId, filename);
  const uploadsRoot = path.resolve(config.UPLOADS_DIR);
  const resolved = path.resolve(filePath);

  // 要比對到目錄分隔符：只用 startsWith 的話，「uploads-evil」這種前綴相同的兄弟目錄也會通過
  if (!resolved.startsWith(uploadsRoot + path.sep)) {
    return res.status(400).send('無效的檔案路徑');
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).send('找不到檔案');
  }

  // 檔名裡含 photo id，內容不會被原地改寫，可以讓瀏覽器快取（private：不給共用代理快取，
  // 因為這些是需要登入才能看的截圖）；inline：在瀏覽器裡直接顯示，不當成下載
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(resolved);
});

module.exports = router;
