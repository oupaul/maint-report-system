const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const fontkit = require('fontkit');
const sharp = require('sharp');
const dayjs = require('dayjs');
const { nowTaipei } = require('../utils/time');

const statusColors = require('../utils/statusColors');
const { SIGNATURE_ROLES, SIGNATURE_ROLE_LABELS } = require('../utils/validators');
const AssetCategory = require('../models/AssetCategory');
const capacity = require('../utils/capacity');

const SIGNATURE_SECTION_HEIGHT = 100; // 標題 + 兩欄簽名（含圖片、簽署人、時間）實際需要的高度上限
const SIGNATURE_IMG_MAX_HEIGHT = 40;
const SIGNATURE_IMG_MAX_WIDTH = 180;

const IMAGE_DISPLAY_WIDTH = 260; // 單張照片時的顯示寬度（維持原本大小，不受下面兩欄排版影響）
const IMAGE_COL_GAP = 12; // 兩欄照片之間的水平間距
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
    path.join(FONTS_DIR, 'NotoSansTC-Regular.otf'), // 隨 repo 附帶的預設字型
    path.join(FONTS_DIR, 'NotoSansTC-Regular.ttf'),
    path.join(FONTS_DIR, 'NotoSansCJKtc-Regular.otf'),
  ]);
  const bold = findFont([
    path.join(FONTS_DIR, 'NotoSansTC-Bold.otf'),
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
// estimateItemLeadHeight 與 drawItemBlock 都呼叫這個函式，確保估算/實際繪製用的是同一個高度上限。
function getPerPhotoMaxHeight(photoCount, maxImageHeight) {
  return photoCount > 1 ? Math.min(150, maxImageHeight) : maxImageHeight;
}

// 只有一張照片時維持原本寬版單欄；有兩張以上時排成兩欄（一列兩張），
// estimateItemLeadHeight 與 drawItemBlock 都呼叫這個函式，欄數判斷才不會兩邊各算一套。
function getImageColumnCount(photoCount) {
  return photoCount > 1 ? 2 : 1;
}

function getImageColumnWidth(photoCount, bodyWidth) {
  return getImageColumnCount(photoCount) === 2
    ? (bodyWidth - IMAGE_COL_GAP) / 2
    : IMAGE_DISPLAY_WIDTH;
}

// 依照片實際寬高比例、指定的顯示寬度算出顯示高度，沒有寬高資訊時用保守固定值。
// estimateItemLeadHeight 與 drawItemBlock 共用同一個計算，避免兩邊估算不一致。
function computeImageDisplayHeight(photo, displayWidth, maxHeight) {
  const raw = (photo.width && photo.height)
    ? displayWidth * (photo.height / photo.width)
    : IMAGE_FALLBACK_HEIGHT;
  return Math.min(raw, maxHeight);
}

/**
 * 只估算「核心內容＋第一張照片」需要的高度，用來在畫之前決定要不要主動換頁
 * （doc.heightOfString 不會移動 doc.y，可安全用來測量）。
 *
 * 刻意不把全部照片加總：一個項目上傳很多張照片時（例如 7 張），全部加起來
 * 可能比一整頁的可用高度還高，這時候「必須整批擠進同一頁」的估算永遠不可能
 * 成立，實際發生過的結果是 cursorY 一路往下累加、超出頁面邊界的照片直接畫
 * 到看不見的地方、憑空消失。真正需要保持不可分割的只有「標籤/數值/備註＋
 * 第一列照片（兩張以上時一列最多兩張）」，後面幾列改由 drawItemBlock() 自己
 * 逐列檢查換頁，一定會出現在某一頁上，只是不保證跟第一列同頁。
 */
// 「數值」那一段要印的文字：容量型項目（有磁碟區）一個磁碟區一行；否則是原本的文字數值。
// 估算高度與實際繪製都用這個函式，兩邊才不會兜不起來。
function valueTextOf(item) {
  if (item.volumes && item.volumes.length > 0) return `數值：\n${capacity.volumeLines(item.volumes).join('\n')}`;
  return item.value_text ? `數值：${item.value_text}` : null;
}

function estimateItemLeadHeight(doc, item, contentWidth, maxImageHeight, fonts) {
  let height = LABEL_ROW_HEIGHT;

  const bodyWidth = contentWidth - 20; // 區塊左右各留一點內距
  const valueText = valueTextOf(item);
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
    const columns = getImageColumnCount(photos.length);
    const imgColWidth = getImageColumnWidth(photos.length, bodyWidth);
    const perPhotoMax = getPerPhotoMaxHeight(photos.length, maxImageHeight);
    const firstRowHeight = Math.max(
      ...photos.slice(0, columns).map(p => computeImageDisplayHeight(p, imgColWidth, perPhotoMax))
    );
    height += IMAGE_GAP + firstRowHeight;
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

// 這裡完全不依賴 pdfkit 的自動游標移動（doc.text() 自動推進 doc.y）或
// doc.moveDown()（依「目前使用中字型的行高」換算間距）——兩者都曾經因為
// drawStatusBadge() 暫時切換字級、或 CJK 字型行高與預期不同，算出來的間距
// 不夠，導致下一行/圖片疊到前一行文字上。改成完全自己控制一個 cursorY，
// 每畫一個元素就依固定常數往下推，跟 estimateItemBlockHeight() 用的是同一套
// 常數（LABEL_ROW_HEIGHT / INNER_GAP / IMAGE_GAP），估算跟實際繪製才會一致。
async function drawItemBlock(doc, item, contentWidth, maxImageHeight, fonts) {
  const startX = doc.page.margins.left;
  const bodyWidth = contentWidth - 20;
  let cursorY = doc.y;

  // 標籤 + 狀態徽章列
  doc.font(fonts.bold).fontSize(11).fillColor('#1E293B');
  doc.text(item.checklist_label, startX, cursorY, { lineBreak: false, width: bodyWidth - 90 });
  drawStatusBadge(doc, startX + bodyWidth - 80, cursorY - 2, item.status, fonts);
  cursorY += LABEL_ROW_HEIGHT;

  const valueDisplay = valueTextOf(item);
  if (valueDisplay) {
    doc.font(fonts.regular).fontSize(10).fillColor('#334155');
    const text = valueDisplay;
    doc.text(text, startX, cursorY, { width: bodyWidth });
    cursorY += doc.heightOfString(text, { width: bodyWidth }) + INNER_GAP;
  }

  if (item.note) {
    doc.font(fonts.regular).fontSize(10).fillColor('#64748B');
    const text = `備註：${item.note}`;
    doc.text(text, startX, cursorY, { width: bodyWidth });
    cursorY += doc.heightOfString(text, { width: bodyWidth }) + INNER_GAP;
  }

  const photos = item.photos || [];
  if (photos.length > 0) {
    // 只有一張照片維持原本寬版單欄；兩張以上排成兩欄（一列兩張），跟
    // estimateItemLeadHeight() 用同一組函式算欄數/欄寬，兩邊才不會兜不起來。
    const columns = getImageColumnCount(photos.length);
    const imgColWidth = getImageColumnWidth(photos.length, bodyWidth);
    const perPhotoMax = getPerPhotoMaxHeight(photos.length, maxImageHeight);
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    for (let i = 0; i < photos.length; i += columns) {
      const rowPhotos = photos.slice(i, i + columns);
      const rowHeights = rowPhotos.map(p => computeImageDisplayHeight(p, imgColWidth, perPhotoMax));
      const rowHeight = Math.max(...rowHeights);

      // 每一列各自檢查剩餘空間，不夠就先換頁：一個項目上傳很多張照片時，
      // 全部照片疊在一起可能比一整頁還高，不可能整批擠進同一頁——保證的是
      // 「同一列的照片」不會被拆到兩頁，不是整批照片一定同頁。呼叫端
      // （estimateItemLeadHeight）只確保核心內容＋第一列擠得下才開始畫，
      // 後面幾列就靠這裡逐列換頁；不這樣做的話，超出頁面邊界的照片會被
      // 畫到看不見的地方、報告裡憑空消失（先前發生過的 bug）。
      if (cursorY + rowHeight > pageBottom) {
        doc.addPage();
        cursorY = doc.y;
      }

      for (let col = 0; col < rowPhotos.length; col++) {
        const photo = rowPhotos[col];
        const displayHeight = rowHeights[col];
        const x = startX + col * (imgColWidth + IMAGE_COL_GAP);

        try {
          const pngBuffer = await decodeScreenshotToPng(photo.path);
          doc.image(pngBuffer, x, cursorY, {
            fit: [imgColWidth, displayHeight],
          });
        } catch (err) {
          // CJK 字型多半沒有斜體字重，找不到字型時退回的 Helvetica-Oblique 也
          // 不支援中文，因此這裡統一用一般字重顯示，不強求斜體。
          doc.font(fonts.regular).fontSize(9).fillColor('#DC2626');
          doc.text('圖片無法顯示', x, cursorY);
        }
      }

      cursorY += rowHeight + IMAGE_GAP;
    }
  }

  doc.y = cursorY + BLOCK_GAP;
}

/**
 * 報告最後的簽名區塊：工程師／主管並排各一欄，簽名圖直接是 PNG（畫布
 * canvas.toDataURL() 產生），doc.image() 原生支援，不需要像截圖那樣經過
 * sharp 轉碼。固定高度、不像項目區塊需要動態估算，換頁保護只需在畫之前
 * 確認剩餘空間足夠即可。
 */
function drawSignatureSection(doc, signaturesByRole, fonts) {
  // 簽核通常是報告最後一段，內容本身不高（標題＋一行簽名圖＋一行姓名/時間），
  // 沒必要跟前面章節一樣保留一整頁的空間才畫——只要剩餘空間放得下這個精簡
  // 版面就直接接在同一頁，放不下才換頁（例如前面內容剛好幾乎畫滿整頁）。
  if (doc.y + SIGNATURE_SECTION_HEIGHT > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const startX = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = contentWidth / SIGNATURE_ROLES.length;
  const colGap = 16;

  doc.font(fonts.bold).fontSize(12).fillColor('#1E293B');
  doc.text('簽核', startX, doc.y);
  doc.moveDown(0.4);
  const rowTop = doc.y;

  SIGNATURE_ROLES.forEach((role, i) => {
    const colX = startX + i * colWidth;
    const colInnerWidth = colWidth - colGap;
    const sig = signaturesByRole[role];
    let y = rowTop;

    doc.font(fonts.regular).fontSize(9).fillColor('#64748B');
    doc.text(SIGNATURE_ROLE_LABELS[role] || role, colX, y, { lineBreak: false });
    y += 13;

    if (sig && sig.signature_path && fs.existsSync(sig.signature_path)) {
      try {
        const pngBuffer = fs.readFileSync(sig.signature_path);
        doc.image(pngBuffer, colX, y, {
          fit: [SIGNATURE_IMG_MAX_WIDTH, SIGNATURE_IMG_MAX_HEIGHT],
        });
      } catch (err) {
        doc.font(fonts.regular).fontSize(9).fillColor('#DC2626');
        doc.text('簽名圖片無法顯示', colX, y, { lineBreak: false });
      }
      y += SIGNATURE_IMG_MAX_HEIGHT + 4;

      doc.moveTo(colX, y).lineTo(colX + colInnerWidth, y).strokeColor('#E2E8F0').stroke();
      y += 4;

      const signerName = sig.display_name || sig.username;
      doc.font(fonts.regular).fontSize(8).fillColor('#94A3B8');
      doc.text(`${signerName} ・ ${dayjs(sig.signed_at).format('YYYY-MM-DD HH:mm')}`, colX, y, { lineBreak: false });
    } else {
      y += SIGNATURE_IMG_MAX_HEIGHT + 4;
      doc.moveTo(colX, y).lineTo(colX + colInnerWidth, y).strokeColor('#E2E8F0').stroke();
      y += 4;
      doc.font(fonts.regular).fontSize(8).fillColor('#94A3B8');
      doc.text('尚未簽署', colX, y, { lineBreak: false });
    }
  });

  doc.y = rowTop + 13 + SIGNATURE_IMG_MAX_HEIGHT + 4 + 4 + 12;
}

// 簽核紀錄（有走簽核流程的批次才會有）：每個關卡一行——關卡、結果、簽核人、時間，有意見就接在下一行。
// 放在簽名區後面；放不下才換頁，跟簽名區一樣不獨佔一整頁。
function drawApprovalSection(doc, approval, fonts) {
  if (!approval || !approval.records || approval.records.length === 0) return;
  const startX = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const STATUS_TEXT = { approved: '核准', returned: '退回', waiting: '待簽核' };

  let estimate = 40;
  for (const r of approval.records) estimate += 16 + (r.comment ? 14 : 0);
  if (doc.y + estimate > doc.page.height - doc.page.margins.bottom) doc.addPage();
  else doc.moveDown(0.9); // 接在簽名區後面時留一點間距，不要緊貼著上方的簽署人姓名與時間

  doc.font(fonts.bold).fontSize(12).fillColor('#1E293B');
  doc.text('簽核紀錄', startX, doc.y);
  doc.moveDown(0.3);
  if (approval.submittedBy) {
    doc.font(fonts.regular).fontSize(8).fillColor('#94A3B8');
    doc.text(`送審：${approval.submittedBy}${approval.submittedAt ? `　${dayjs(approval.submittedAt).format('YYYY-MM-DD HH:mm')}` : ''}`, startX, doc.y, { width: contentWidth });
    doc.moveDown(0.3);
  }

  for (const r of approval.records) {
    const who = r.status === 'waiting' ? '' : (r.approver_name || r.approver_username || '');
    const when = r.acted_at ? dayjs(r.acted_at).format('YYYY-MM-DD HH:mm') : '';
    const color = r.status === 'approved' ? '#16A34A' : (r.status === 'returned' ? '#DC2626' : '#D97706');
    doc.font(fonts.regular).fontSize(9).fillColor('#1E293B');
    doc.text(`${r.stage_label}`, startX, doc.y, { continued: true, width: contentWidth });
    doc.fillColor(color).text(`　${STATUS_TEXT[r.status] || r.status}`, { continued: true });
    doc.fillColor('#64748B').text(`${who ? `　${who}` : ''}${when ? `　${when}` : ''}${r.acted_as_admin ? '（管理員代為處理）' : ''}`);
    if (r.comment) {
      doc.font(fonts.regular).fontSize(8).fillColor('#64748B');
      doc.text(`意見：${r.comment}`, startX + 12, doc.y, { width: contentWidth - 12 });
    }
  }
  doc.moveDown(0.5);
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
// partial＝只含部分客戶的設備（選客戶下載、或每家客戶各一份）：封面只寫這些客戶，並註明不是完整內容
async function generateBatchReport({ batch, assets, itemsByAssetId, signaturesByRole, approval, partial = false }, outputStream) {
  // 含已停用的類型：舊報告仍要顯示得出類型名稱
  const categoryLabels = AssetCategory.labelMap();
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  doc.pipe(outputStream);

  const fonts = registerFonts(doc);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxImageHeight = (doc.page.height - doc.page.margins.top - doc.page.margins.bottom) * 0.7;

  // 標題
  doc.font(fonts.bold).fontSize(20).fillColor('#1E293B').text(batch.title, { align: 'left' });
  doc.font(fonts.regular).fontSize(10).fillColor('#64748B');
  doc.text(`巡檢日期：${dayjs(batch.batch_date).format('YYYY-MM-DD')}`);
  doc.text(`報告產生時間：${dayjs(nowTaipei()).format('YYYY-MM-DD HH:mm')}`);
  // 批次可以涵蓋多家客戶：封面列出客戶，每台設備那一頁也標示所屬客戶
  const customerNames = [...new Set(assets.map(a => a.customer_name).filter(Boolean))];
  const hasUnassigned = assets.some(a => !a.customer_name);
  if (customerNames.length) {
    // 只有一家客戶時一併印統一編號
    const taxId = customerNames.length === 1 ? (assets.find(a => a.customer_name) || {}).customer_tax_id : null;
    const unassignedText = hasUnassigned ? (partial ? '（含未指定客戶的設備）' : '（另有設備未指定客戶）') : '';
    doc.text(`客戶：${customerNames.join('、')}${taxId ? `（統一編號 ${taxId}）` : ''}${unassignedText}`);
  } else if (partial && hasUnassigned) {
    doc.text('客戶：未指定客戶');
  }
  if (partial) doc.text('本報告僅含上列客戶的設備，不是整張巡檢單的完整內容。');
  if (batch.notes) {
    doc.text(`備註：${batch.notes}`);
  }
  doc.moveDown(1);

  for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
    const asset = assets[assetIndex];
    // 每個資產都從新的一頁開始（第一個資產緊接在報告標題後面，不用換頁）。
    // 原本只在「剩餘空間放不下資產標題本身」時才換頁，結果標題可能剛好卡在
    // 頁尾擠得下、但底下的檢查項目/截圖整批被推到下一頁，標題跟內容斷開、
    // 讀起來很奇怪；改成一個資產固定佔用自己的頁面，報告也更適合逐設備列印。
    if (assetIndex > 0) {
      doc.addPage();
    } else {
      doc.moveDown(0.5);
    }
    doc.font(fonts.bold).fontSize(14).fillColor('#F97316');
    doc.text(`${asset.name}`, doc.page.margins.left, doc.y);
    doc.font(fonts.regular).fontSize(9).fillColor('#64748B');
    doc.text(
      (asset.customer_name ? `客戶：${asset.customer_name}　` : '') +
      `類別：${categoryLabels[asset.category] || asset.category}` +
      (asset.location ? `　位置：${asset.location}` : '') +
      (asset.hostname ? `　主機名稱：${asset.hostname}` : '') +
      (asset.ip_address ? `　IP：${asset.ip_address}` : '') +
      (asset.mac_address ? `　MAC：${asset.mac_address}` : '')
    );
    const brandModel = [asset.brand, asset.model].filter(Boolean).join(' ');
    const line2 =
      (brandModel ? `廠牌／型號：${brandModel}` : '') +
      (asset.serial_number ? `　序號：${asset.serial_number}` : '') +
      (asset.asset_tag ? `　財產編號：${asset.asset_tag}` : '') +
      (asset.purchase_date ? `　購置日期：${asset.purchase_date}` : '') +
      (asset.identifier ? `　識別碼：${asset.identifier}` : '');
    if (line2.trim()) doc.text(line2.trim());
    // 管理員自訂的欄位（只印啟用中、適用這個類別、而且有填的）
    const line3 = (asset.customDisplay || []).map(c => `${c.label}：${c.text}`).join('　');
    if (line3) doc.text(line3);
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
      const estimatedHeight = estimateItemLeadHeight(doc, item, contentWidth, maxImageHeight, fonts);

      // 主動換頁：畫之前先判斷，避免區塊被硬切成兩頁
      if (doc.y + estimatedHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      await drawItemBlock(doc, item, contentWidth, maxImageHeight, fonts);
    }
  }

  drawSignatureSection(doc, signaturesByRole || {}, fonts);
  drawApprovalSection(doc, approval, fonts);

  doc.end();

  return new Promise((resolve, reject) => {
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);
  });
}

module.exports = { generateBatchReport, registerFonts };
