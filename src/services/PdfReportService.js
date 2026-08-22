const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const sharp = require('sharp');
const dayjs = require('dayjs');

const statusColors = require('../utils/statusColors');
const { ASSET_CATEGORY_LABELS } = require('../utils/validators');

const IMAGE_DISPLAY_WIDTH = 260;
const IMAGE_FALLBACK_HEIGHT = 180;
const IMAGE_GAP = 8;
const LABEL_ROW_HEIGHT = 22;
const BLOCK_GAP = 14;
const INNER_GAP = 6;

// pdfkit 內建的 Helvetica 系列字型不支援中文（CJK），若沒有另外嵌入字型，
// 所有中文文字（本報告全部內容）都會顯示為空白或亂碼。
// 比照姊妹專案 pbg-system 的作法：可選擇性地把支援 CJK 的字型檔（例如
// Noto Sans TC）放到專案根目錄的 fonts/ 目錄，找不到就退回 Helvetica
// （英數字仍可正常顯示，但中文會無法正確呈現，不會導致報告產生失敗）。
const FONTS_DIR = path.join(__dirname, '..', '..', 'fonts');

function findFont(candidates) {
  return candidates.find(p => fs.existsSync(p)) || null;
}

function getCjkFontPaths() {
  const regular = findFont([
    path.join(FONTS_DIR, 'NotoSansTC-Regular.ttf'),
    path.join(FONTS_DIR, 'NotoSansCJKtc-Regular.otf'),
  ]);
  const bold = findFont([
    path.join(FONTS_DIR, 'NotoSansTC-Bold.ttf'),
    path.join(FONTS_DIR, 'NotoSansCJKtc-Bold.otf'),
  ]);
  return { regular, bold: bold || regular };
}

/**
 * 有些系統字型（例如 macOS 內建的 .ttc）是包含多個字重/語系的「字型集合」，
 * pdfkit 的 doc.registerFont() 需要額外指定 family（實際上是該字型集合裡
 * 其中一個 face 的 postscriptName）才能正確嵌入，否則 fontkit 回傳的物件
 * 不具備 pdfkit 內部需要的 createSubset()，會在畫第一個字時才炸掉。
 * 一般建議使用的 Noto Sans TC 單一 .ttf/.otf 檔不受影響（fontkit 開啟
 * 單一字型檔時 .fonts 為 undefined，這裡會直接跳過、回傳 undefined family）。
 */
function resolveFontFamily(fontPath) {
  try {
    const font = fontkit.openSync(fontPath);
    if (font && Array.isArray(font.fonts) && font.fonts.length > 0) {
      return font.fonts[0].postscriptName;
    }
  } catch (err) {
    // 開不了就交給 pdfkit 本身處理／報錯，這裡不用管
  }
  return undefined;
}

/**
 * 在 doc 上註冊 CJK 字型（若找得到字型檔），回傳可用的字型名稱對照表。
 * 找不到字型檔時退回 pdfkit 內建的 Helvetica 系列，並印一次警告。
 */
function registerFonts(doc) {
  const { regular, bold } = getCjkFontPaths();

  if (regular) {
    doc.registerFont('CJK', regular, resolveFontFamily(regular));
    doc.registerFont('CJK-Bold', bold, resolveFontFamily(bold));
    return { regular: 'CJK', bold: 'CJK-Bold' };
  }

  console.warn(
    '[PdfReportService] 找不到 CJK 字型檔（fonts/NotoSansTC-Regular.ttf），' +
    '報告中的中文文字可能無法正確顯示。請參考 fonts/README.md 放入字型檔。'
  );
  return { regular: 'Helvetica', bold: 'Helvetica-Bold' };
}

// 一個項目可能有多張照片，多張時每張的顯示高度上限縮小，避免單一區塊佔滿好幾頁；
// estimateItemBlockHeight 與 drawItemBlock 都呼叫這個函式，確保估算/實際繪製用的是同一個高度上限。
function getPerPhotoMaxHeight(photoCount, maxImageHeight) {
  return photoCount > 1 ? Math.min(150, maxImageHeight) : maxImageHeight;
}

// 依照片實際寬高比例算出顯示高度（寬固定為 IMAGE_DISPLAY_WIDTH），沒有寬高資訊時用保守固定值。
// estimateItemBlockHeight 與 drawItemBlock 共用同一個計算，避免兩邊估算不一致。
function computeImageDisplayHeight(photo, maxHeight) {
  const raw = (photo.width && photo.height)
    ? IMAGE_DISPLAY_WIDTH * (photo.height / photo.width)
    : IMAGE_FALLBACK_HEIGHT;
  return Math.min(raw, maxHeight);
}

/**
 * 估算單一 inspection_item 區塊畫出來需要多少高度，
 * 用來在畫之前決定要不要主動換頁（doc.heightOfString 不會移動 doc.y，可安全用來測量）。
 */
function estimateItemBlockHeight(doc, item, contentWidth, maxImageHeight, fonts) {
  let height = LABEL_ROW_HEIGHT;

  const bodyWidth = contentWidth - 20; // 區塊左右各留一點內距
  const valueText = item.value_text ? `數值：${item.value_text}` : null;
  const noteText = item.note ? `備註：${item.note}` : null;

  doc.font(fonts.regular).fontSize(10);
  if (valueText) {
    height += INNER_GAP + doc.heightOfString(valueText, { width: bodyWidth });
  }
  if (noteText) {
    height += INNER_GAP + doc.heightOfString(noteText, { width: bodyWidth });
  }

  const photos = item.photos || [];
  if (photos.length > 0) {
    const perPhotoMax = getPerPhotoMaxHeight(photos.length, maxImageHeight);
    for (const photo of photos) {
      height += INNER_GAP + computeImageDisplayHeight(photo, perPhotoMax);
    }
  }

  return height + BLOCK_GAP;
}

async function decodeScreenshotToPng(screenshotPath) {
  const raw = fs.readFileSync(screenshotPath);
  // pdfkit 的 doc.image() 只原生支援 JPEG/PNG，不支援 WebP，
  // 因此無論儲存格式為何，一律重新解碼成 PNG buffer 再交給 pdfkit。
  return sharp(raw).png().toBuffer();
}

function drawStatusBadge(doc, x, y, status, fonts) {
  const info = statusColors[status] || statusColors.normal;
  const label = info.label;
  doc.font(fonts.bold).fontSize(9);
  const textWidth = doc.widthOfString(label);
  const badgeWidth = textWidth + 16;
  const badgeHeight = 16;

  doc.save();
  doc.roundedRect(x, y, badgeWidth, badgeHeight, 3).fill(info.bg);
  doc.fillColor(info.color).text(label, x + 8, y + 4, { lineBreak: false });
  doc.restore();

  return badgeWidth;
}

async function drawItemBlock(doc, item, contentWidth, maxImageHeight, fonts) {
  const startX = doc.page.margins.left;
  const bodyWidth = contentWidth - 20;

  // 標籤 + 狀態徽章列
  doc.font(fonts.bold).fontSize(11).fillColor('#1E293B');
  doc.text(item.checklist_label, startX, doc.y, { continued: false, width: bodyWidth - 90 });
  const labelY = doc.y - doc.currentLineHeight();
  drawStatusBadge(doc, startX + bodyWidth - 80, labelY, item.status, fonts);
  doc.moveDown(0.3);

  if (item.value_text) {
    doc.font(fonts.regular).fontSize(10).fillColor('#334155');
    doc.text(`數值：${item.value_text}`, startX, doc.y, { width: bodyWidth });
    doc.moveDown(0.15);
  }

  if (item.note) {
    doc.font(fonts.regular).fontSize(10).fillColor('#64748B');
    doc.text(`備註：${item.note}`, startX, doc.y, { width: bodyWidth });
    doc.moveDown(0.15);
  }

  const photos = item.photos || [];
  if (photos.length > 0) {
    const perPhotoMax = getPerPhotoMaxHeight(photos.length, maxImageHeight);
    for (const photo of photos) {
      const displayHeight = computeImageDisplayHeight(photo, perPhotoMax);
      const drawY = doc.y;

      try {
        const pngBuffer = await decodeScreenshotToPng(photo.path);
        doc.image(pngBuffer, startX, drawY, {
          fit: [IMAGE_DISPLAY_WIDTH, displayHeight],
        });
      } catch (err) {
        // CJK 字型多半沒有斜體字重，找不到字型時退回的 Helvetica-Oblique 也
        // 不支援中文，因此這裡統一用一般字重顯示，不強求斜體。
        doc.font(fonts.regular).fontSize(9).fillColor('#DC2626');
        doc.text('圖片無法顯示', startX, drawY);
      }

      // doc.image() 跟 doc.text() 不一樣，畫完不會自動移動 doc.y，
      // 一定要用估算時同一套高度公式手動往下推，否則下一張照片／下一個
      // 項目區塊會直接疊畫在這張圖片上面（先前 PDF 版面錯位就是這個原因）。
      doc.y = drawY + displayHeight + IMAGE_GAP;
    }
  }

  doc.moveDown(0.6);
}

/**
 * 產生單一 inspection_batches 的巡檢報告 PDF，依資產分組，每個 inspection_item
 * 視為不可分頁區塊（先估算高度、必要時主動換頁，再畫）。
 *
 * @param {object} params
 * @param {object} params.batch inspection_batches 資料列
 * @param {Array<object>} params.assets 該批次涵蓋的 assets
 * @param {Map<number, Array<object>>} params.itemsByAssetId asset_id -> inspection_items（含 join 欄位）
 * @param {import('stream').Writable} outputStream 目標輸出串流（例如 Express res）
 */
async function generateBatchReport({ batch, assets, itemsByAssetId }, outputStream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(outputStream);

  const fonts = registerFonts(doc);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxImageHeight = (doc.page.height - doc.page.margins.top - doc.page.margins.bottom) * 0.7;

  // 標題
  doc.font(fonts.bold).fontSize(20).fillColor('#1E293B').text(batch.title, { align: 'left' });
  doc.font(fonts.regular).fontSize(10).fillColor('#64748B');
  doc.text(`巡檢日期：${dayjs(batch.batch_date).format('YYYY-MM-DD')}`);
  doc.text(`報告產生時間：${dayjs().format('YYYY-MM-DD HH:mm')}`);
  if (batch.notes) {
    doc.text(`備註：${batch.notes}`);
  }
  doc.moveDown(1);

  for (const asset of assets) {
    // 資產群組標題可自然跨頁換行，不需要主動換頁保護
    if (doc.y + 40 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
    doc.moveDown(0.5);
    doc.font(fonts.bold).fontSize(14).fillColor('#F97316');
    doc.text(`${asset.name}`, doc.page.margins.left, doc.y);
    doc.font(fonts.regular).fontSize(9).fillColor('#64748B');
    doc.text(
      `類別：${ASSET_CATEGORY_LABELS[asset.category] || asset.category}` +
      (asset.location ? `　位置：${asset.location}` : '') +
      (asset.identifier ? `　識別碼：${asset.identifier}` : '')
    );
    doc.moveDown(0.4);

    // 底線
    doc.moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .strokeColor('#E2E8F0')
      .stroke();
    doc.moveDown(0.5);

    const items = itemsByAssetId.get(asset.id) || [];

    if (items.length === 0) {
      doc.font(fonts.regular).fontSize(9).fillColor('#94A3B8');
      doc.text('（此資產尚無檢查紀錄）');
      doc.moveDown(0.8);
      continue;
    }

    for (const item of items) {
      const estimatedHeight = estimateItemBlockHeight(doc, item, contentWidth, maxImageHeight, fonts);

      // 主動換頁：畫之前先判斷，避免區塊被硬切成兩頁
      if (doc.y + estimatedHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      await drawItemBlock(doc, item, contentWidth, maxImageHeight, fonts);
    }
  }

  doc.end();

  return new Promise((resolve, reject) => {
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);
  });
}

module.exports = { generateBatchReport };
