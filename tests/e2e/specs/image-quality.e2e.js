// 圖片畫質：上傳處理（ImageService）、PDF 內嵌圖片的格式與解析度、報價 PDF 畫質、真的從網頁上傳一張截圖。
// 背景：「系統能呈現的清晰度，最多就是上傳當下保留下來的」——原圖不另存，所以這裡鎖住上限，避免被誤調低。
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

module.exports = {
  name: '圖片畫質（上傳與 PDF）',
  needs: ['browser', 'poppler'],
  async run(t) {
    // ===== 1. 上傳處理 =====
    const { processScreenshot, MAX_DIMENSION } = t.require('src/services/ImageService');
    t.ok(MAX_DIMENSION === 3200, '長邊上限是 3200px');
    const orig = await t.shotPng(2880, 1800, 'A');
    const r = await processScreenshot(orig, 'image/png', path.join(t.tmpDir, 'unit-a'));
    t.ok(r.width === 2880 && r.height === 1800, `Retina 螢幕截圖 2880×1800 不再被縮小（${r.width}×${r.height}）`);
    const err = async (buf, w, h) => {
      const a = await sharp(orig).greyscale().raw().toBuffer();
      const b = await sharp(buf).resize(w, h).greyscale().raw().toBuffer();
      let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
      return s / a.length;
    };
    const newErr = await err(fs.readFileSync(r.path), 2880, 1800);
    const oldErr = await err(await sharp(orig).resize({ width: 2000, height: 2000, fit: 'inside' }).webp({ quality: 82 }).toBuffer(), 2880, 1800);
    t.ok(newErr < oldErr / 2, `文字截圖還原得比舊做法（2000px、品質 82）準確至少 2 倍（平均誤差 ${newErr.toFixed(3)} vs ${oldErr.toFixed(3)}）`);
    const photo = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: { r: 90, g: 120, b: 150 } } }).jpeg().toBuffer();
    const r2 = await processScreenshot(photo, 'image/jpeg', path.join(t.tmpDir, 'unit-b'));
    t.ok(r2.width === 3200 && r2.height === 2400 && r2.format === 'webp', '4032×3024 的手機照片 → 3200×2400 WebP');
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888' } }).png().toBuffer();
    t.ok((await processScreenshot(small, 'image/png', path.join(t.tmpDir, 'unit-c'))).width === 800, '小圖不會被放大');
    let bad = false;
    try { await processScreenshot(Buffer.from('not an image'), 'image/png', path.join(t.tmpDir, 'unit-d')); } catch (e) { bad = !!e.userFacing; }
    t.ok(bad, '不是圖片的檔案仍然被拒絕，並給使用者看得懂的錯誤');

    // ===== 2. 批次報告 PDF =====
    const ctx = await t.mkReportBatch();
    const admin = await t.login('admin');
    const f1 = path.join(t.tmpDir, 'report.pdf');
    const rr = await t.download(admin, `/batches/${ctx.bid}/report.pdf`);
    fs.writeFileSync(f1, rr.buf);
    t.ok(rr.status === 200 && /pdf/.test(rr.type), 'report.pdf 回 200');
    const I = t.pdfImages(f1);
    t.ok(I.length === 5, '5 張照片都有嵌入');
    t.ok(I.filter(i => i.w >= 2000).every(i => i.ppi >= 450), `來源夠大的照片，印出來至少 450 ppi（最低 ${Math.min(...I.filter(i => i.w >= 2000).map(i => i.ppi))}）`);
    t.ok(I.find(i => i.w === 1366).ppi >= 200, '1366px 的小截圖以它自己的解析度嵌入（不可能比來源更清楚）');
    const phone = I.find(i => i.w === 3200), retina = I.filter(i => i.w === 2880);
    t.ok(phone && phone.enc === 'jpeg', '相機照片嵌 JPEG（檔案小）');
    t.ok(retina.length === 3 && retina.every(i => i.enc === 'image'), '螢幕截圖嵌無損（PNG／flate），完整 2880px');
    const single = I.find(i => i.w === 2880 && i.page === I[0].page);
    t.ok(single && single.ppi >= 450, `單張照片印得很大（約 ${single.ppi} ppi，內文寬度約 450pt）`);
    const sizeKB = Math.round(fs.statSync(f1).size / 1024);
    t.ok(sizeKB < 6000, `報告檔案大小合理（${sizeKB} KB）`);

    // ===== 3. 報價 PDF（Email 附件／下載）：高畫質版 vs 附件太大時的退路 =====
    const QuotePdf = t.require('src/services/QuotePdfService');
    const photos = t.q('SELECT path FROM inspection_item_photos ORDER BY id').map(r => ({ path: r.path }));
    const detail = { request: { id: 1, urgency: 'normal', requested_by_name: '測試', sent_at: t.NOW, requested_at: t.NOW, description: '測試' }, asset: { name: 'ERP-DB01', customerName: '甲公司' },
      items: [{ label: '備份狀態', status: 'warning', display: 'x', note: null, extra: null, batch_date: '2026-10-19', batch_title: 't', photos: photos.slice(0, 3) }] };
    const hi = await QuotePdf.generate(detail, {}), lo = await QuotePdf.generate(detail, {}, { quality: 'standard' });
    const ih = t.pdfImages(t.tmpFile('q-hi.pdf', hi)), il = t.pdfImages(t.tmpFile('q-lo.pdf', lo));
    t.ok(Math.max(...ih.map(i => i.w)) >= 2000 && Math.max(...il.map(i => i.w)) <= 900, '報價 PDF：高畫質版嵌 ≥2000px，退路版 ≤900px');
    t.ok(hi.length > lo.length, '高畫質版比退路版大（所以「超過附件上限就降級」才有意義）');
    t.ok(Math.min(...ih.map(i => i.ppi)) >= Math.max(...il.map(i => i.ppi)) * 0.9, '報價 PDF 高畫質版的有效解析度不低於舊版');

    // ===== 4. 真的從網頁上傳一張 Retina 截圖（走正式的上傳處理與就地儲存） =====
    const file = t.tmpFile('upload.png', await t.shotPng(2880, 1800, 'U'));
    await t.go(admin, `/batches/${ctx.bid}/entry`);
    const target = t.q('SELECT ii.id, ii.asset_id, ii.checklist_item_id FROM inspection_items ii WHERE ii.batch_id = ? AND NOT EXISTS (SELECT 1 FROM inspection_item_photos p WHERE p.inspection_item_id = ii.id) ORDER BY ii.id LIMIT 1', ctx.bid)[0];
    t.ok(!!target, '找到一個還沒有截圖的檢查項目');
    const before = t.count('inspection_item_photos', 'inspection_item_id=?', target.id);
    // 網址上的 :id 是「檢查項目」編號，照片掛在「巡檢紀錄列」（inspection_items.id）底下
    const form = (await admin.evaluateHandle((x) => [...document.querySelectorAll('form')].find(f => f.querySelector('input[type=file]')
      && (f.getAttribute('action') || '').includes('/items/' + x.checklist_item_id + '?') && (f.querySelector('input[name=asset_id]') || {}).value === String(x.asset_id)), target)).asElement();
    t.ok(!!form, '找到該項目的上傳表單');
    await (await form.$('input[type=file]')).uploadFile(file);
    await t.sleep(800);
    const save = await admin.evaluateHandle((f) => [...f.querySelectorAll('button')].find(b => b.textContent.trim() === '儲存'), form);
    await save.asElement().evaluate(b => b.scrollIntoView({ block: 'center' }));
    await save.asElement().click();
    for (let i = 0; i < 40; i++) { await t.sleep(500); if (t.count('inspection_item_photos', 'inspection_item_id=?', target.id) > before) break; }
    const saved = t.q('SELECT * FROM inspection_item_photos WHERE inspection_item_id = ? ORDER BY id DESC LIMIT 1', target.id)[0];
    t.ok(saved && t.count('inspection_item_photos', 'inspection_item_id=?', target.id) === before + 1, '截圖透過網頁存進去了');
    t.ok(saved && saved.width === 2880 && saved.height === 1800 && saved.format === 'webp' && fs.existsSync(saved.path), '以完整 2880×1800 存成 WebP（舊版會縮到 2000）');
    t.ok(saved && fs.statSync(saved.path).size < 6 * 1024 * 1024, `檔案大小合理（${saved && Math.round(fs.statSync(saved.path).size / 1024)} KB）`);
  },
};
