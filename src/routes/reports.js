const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const AssetField = require('../models/AssetField');
const InspectionBatch = require('../models/InspectionBatch');
const InspectionItem = require('../models/InspectionItem');
const InspectionVolume = require('../models/InspectionVolume');
const InspectionItemPhoto = require('../models/InspectionItemPhoto');
const BatchSignature = require('../models/BatchSignature');
const PdfReportService = require('../services/PdfReportService');
const ReportScope = require('../services/ReportScope');
const { ZipStream } = require('../utils/zipStream');
const { Writable } = require('stream');
const ApprovalService = require('../services/ApprovalService');
const config = require('../config');

// 載入報告需要的資料（含所有客戶）；呼叫端再依選取的客戶過濾設備
function loadReportData(batch) {
  const assets = AssetField.attach(InspectionBatch.getAssets(batch.id)); // 補上自訂欄位的值（報告設備頁會印）
  const items = InspectionVolume.attach(InspectionItem.findByBatch(batch.id));
  const photosByItemId = InspectionItemPhoto.findByItemIds(items.map(i => i.id));

  const itemsByAssetId = new Map();
  for (const item of items) {
    item.photos = photosByItemId.get(item.id) || [];
    if (!itemsByAssetId.has(item.asset_id)) itemsByAssetId.set(item.asset_id, []);
    itemsByAssetId.get(item.asset_id).push(item);
  }

  const signaturesByRole = {};
  for (const sig of BatchSignature.findByBatchId(batch.id)) {
    signaturesByRole[sig.role] = sig;
  }
  return { assets, itemsByAssetId, signaturesByRole, approval: ApprovalService.approvalSummary(batch) };
}

const notFound = (res) => res.status(404).render('error', { title: '找不到批次', message: '找不到指定的巡檢批次' });
const badSelection = (res) => res.status(400).render('error', { title: '請選擇客戶', message: '請至少選一家這個批次涵蓋的客戶，再下載報告。' });

// 產生一份 PDF 並回傳 Buffer（打包 ZIP 用；一次只放一份在記憶體）
function pdfBuffer(args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    PdfReportService.generateBatchReport(args, sink).catch(reject);
  });
}

// ?customer=<客戶id|none>（可重複）：只輸出選到的客戶；沒帶＝全部；全選等同全部（不加「僅含部分客戶」的註記）
router.get('/batches/:id/report.pdf', requireLogin, async (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) return notFound(res);

  const data = loadReportData(batch);
  const groups = ReportScope.groupsOf(data.assets, data.itemsByAssetId);
  const selected = ReportScope.parseSelection(req.query, groups);
  let partial = false;
  let assets = data.assets;
  let utf8Name = `batch-${batch.id}-report.pdf`;
  let asciiName = utf8Name;
  if (selected && selected.size < groups.length) {
    if (selected.size === 0) return badSelection(res);
    partial = true;
    assets = ReportScope.pick(data.assets, selected);
    const names = groups.filter(g => selected.has(g.key)).map(g => g.name);
    utf8Name = `batch-${batch.id}-${names.length === 1 ? ReportScope.fileSafe(names[0]) : '多家客戶'}-report.pdf`;
    asciiName = `batch-${batch.id}-partial-report.pdf`;
  } else if (selected && selected.size === 0) {
    return badSelection(res); // 批次沒有任何設備
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', ReportScope.contentDisposition('inline', asciiName, utf8Name));

  try {
    await PdfReportService.generateBatchReport({ batch, assets, itemsByAssetId: data.itemsByAssetId, signaturesByRole: data.signaturesByRole, approval: data.approval, partial }, res);
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

// 每家客戶各一份 PDF，打包成 ZIP（?customer= 可只選部分客戶；沒帶＝這個批次的每一家客戶）
router.get('/batches/:id/reports.zip', requireLogin, async (req, res) => {
  const batch = InspectionBatch.findById(req.params.id);
  if (!batch) return notFound(res);

  const data = loadReportData(batch);
  const groups = ReportScope.groupsOf(data.assets, data.itemsByAssetId);
  const selected = ReportScope.parseSelection(req.query, groups);
  const chosen = selected ? groups.filter(g => selected.has(g.key)) : groups;
  if (chosen.length === 0) return badSelection(res);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', ReportScope.contentDisposition('attachment', `batch-${batch.id}-reports.zip`, `batch-${batch.id}-各客戶報告.zip`));

  try {
    const zip = new ZipStream(res);
    const used = new Set();
    for (const g of chosen) {
      const buf = await pdfBuffer({
        batch,
        assets: ReportScope.pick(data.assets, new Set([g.key])),
        itemsByAssetId: data.itemsByAssetId,
        signaturesByRole: data.signaturesByRole,
        approval: data.approval,
        partial: groups.length > 1, // 批次只有一家客戶時，這份就是完整報告
      });
      let name = `batch-${batch.id}-${ReportScope.fileSafe(g.name)}.pdf`;
      if (used.has(name)) name = `batch-${batch.id}-${ReportScope.fileSafe(g.name)}-${g.key}.pdf`;
      used.add(name);
      await zip.addFile(name, buf);
    }
    await zip.finish();
  } catch (err) {
    console.error('[reports] 打包 ZIP 失敗:', err);
    if (!res.headersSent) res.status(500).send('ZIP 產生失敗');
    else res.destroy();
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
