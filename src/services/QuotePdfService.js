// 單張報價請求的 PDF（一份請求一個檔，含送出當下的設備資料、異常項目、截圖），附在通知業務的 Email 裡，
// 沒有系統帳號的人也看得到完整內容。截圖縮成適合的大小再轉 JPEG，避免檔案太大寄不出去。
const fs = require('fs');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const statusColors = require('../utils/statusColors');
const { registerFonts } = require('./PdfReportService');

const URGENCY_TEXT = { normal: '一般', urgent: '緊急' };

// 設備資料要印哪些欄位由 visibleAssetLines 決定（設定頁可以關掉 IP、MAC 等），畫面與 Email 共用
function visibleAssetLines(snap, settings) {
  const lines = [];
  const line1 = [snap.categoryLabel && `類別：${snap.categoryLabel}`, snap.location && `位置：${snap.location}`, snap.hostname && `主機名稱：${snap.hostname}`].filter(Boolean);
  if (line1.length) lines.push(line1.join('　'));
  const brandModel = [snap.brand, snap.model].filter(Boolean).join(' ');
  const line2 = [
    brandModel && `廠牌／型號：${brandModel}`,
    settings.show_serial && snap.serial_number && `序號：${snap.serial_number}`,
    settings.show_purchase && snap.purchase_date && `購置日期：${snap.purchase_date}`,
  ].filter(Boolean);
  if (line2.length) lines.push(line2.join('　'));
  const net = [settings.show_ip && snap.ip_address && `IP：${snap.ip_address}`, settings.show_mac && snap.mac_address && `MAC：${snap.mac_address}`].filter(Boolean);
  if (net.length) lines.push(net.join('　'));
  if (settings.show_custom && snap.custom && snap.custom.length) lines.push(snap.custom.map(c => `${c.label}：${c.text}`).join('　'));
  return lines;
}

async function generate(detail, settings) {
  const { request, asset, items } = detail;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const fonts = registerFonts(doc);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font(fonts.bold).fontSize(18).fillColor('#1E293B').text(`報價請求單 Q-${request.id}`);
  doc.font(fonts.regular).fontSize(10).fillColor('#64748B');
  doc.text(`緊急程度：${URGENCY_TEXT[request.urgency] || request.urgency}　送出：${request.requested_by_name}　時間：${(request.sent_at || request.requested_at).slice(0, 16)}`);
  doc.moveDown(0.6);

  doc.font(fonts.bold).fontSize(14).fillColor('#F97316').text(asset.name);
  doc.font(fonts.regular).fontSize(9).fillColor('#64748B');
  visibleAssetLines(asset, settings).forEach(l => doc.text(l));
  doc.moveDown(0.5);

  if (request.description) {
    doc.font(fonts.bold).fontSize(10).fillColor('#1E293B').text('工程師說明');
    doc.font(fonts.regular).fontSize(10).fillColor('#334155').text(request.description, { width });
    doc.moveDown(0.6);
  }

  for (const item of items) {
    if (doc.y + 70 > bottom()) doc.addPage();
    const color = (statusColors[item.status] || statusColors.normal);
    const y = doc.y;
    doc.font(fonts.bold).fontSize(11).fillColor('#1E293B').text(item.label, left, y, { lineBreak: false });
    doc.font(fonts.bold).fontSize(9).fillColor(color.color).text(color.label, left + width - 40, y + 1, { lineBreak: false });
    doc.y = y + 20;
    doc.font(fonts.regular).fontSize(10).fillColor('#334155');
    if (item.display) doc.text(item.display.includes('\n') ? `數值：\n${item.display}` : `數值：${item.display}`, left, doc.y, { width });
    if (item.extra) doc.fillColor('#B45309').text(`預測：${item.extra}`, left, doc.y, { width });
    if (item.note) doc.fillColor('#64748B').text(`備註：${item.note}`, left, doc.y, { width });
    doc.font(fonts.regular).fontSize(8).fillColor('#94A3B8').text(`來源：${item.batch_date || ''} ${item.batch_title || ''}`, left, doc.y + 2, { width });
    doc.moveDown(0.4);
    for (const photo of item.photos) {
      try {
        if (!fs.existsSync(photo.path)) continue;
        const buf = await sharp(photo.path).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
        const meta = await sharp(buf).metadata();
        const w = Math.min(300, width);
        const h = Math.min(w * (meta.height / meta.width), 240);
        if (doc.y + h > bottom()) doc.addPage();
        doc.image(buf, left, doc.y, { fit: [w, h] });
        doc.y += h + 8;
      } catch (e) {
        doc.font(fonts.regular).fontSize(8).fillColor('#94A3B8').text('（截圖無法顯示）', left, doc.y);
      }
    }
    doc.moveDown(0.8);
  }
  doc.end();
  return done;
}

module.exports = { generate, visibleAssetLines };
