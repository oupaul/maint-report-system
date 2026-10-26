// 截圖檢視器（就地展開）：縮放（按鈕、Ctrl+滾輪、雙擊、雙指捏合）、拖曳平移、旋轉、還原、鍵盤、換張重置、手機寬度。
// 做法移植自 expense-platform 的 ImageViewer；程式在 src/public/js/photo-viewer.js。
module.exports = {
  name: '截圖檢視器縮放',
  needs: ['browser'],
  async run(t) {
    const ctx = await t.mkReportBatch();
    const p = await t.login('admin', t.PASSWORD, { width: 1280, height: 900 });
    const label = () => p.$eval('.photo-viewer__zoom', e => e.textContent);
    const tf = () => p.$eval('.photo-viewer__img', e => {
      const m = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([\d.]+)\) rotate\((-?[\d.]+)deg\)/.exec(e.style.transform) || [];
      return { x: +m[1], y: +m[2], s: +m[3], r: +m[4] };
    });
    const btn = (txt) => p.evaluateHandle((x) => [...document.querySelectorAll('.photo-viewer__btn')].find(b => b.textContent.includes(x)), txt);
    const click = async (txt) => { const h = await btn(txt); await h.asElement().click(); await t.sleep(60); };
    const stageBox = async () => (await p.$('.photo-viewer__stage')).boundingBox();
    const centre = async () => { await p.evaluate(() => document.querySelector('.photo-viewer__stage').scrollIntoView({ block: 'center' })); await t.sleep(100); return stageBox(); };

    // ---- 摘要頁 ----
    await t.go(p, `/batches/${ctx.bid}`);
    await p.click('a[data-viewer]');
    await p.waitForSelector('.photo-viewer__img:not([hidden])');
    await t.sleep(100);
    t.ok(await label() === '100%' && (await tf()).s === 1, '檢視器開啟時是 100%');
    t.ok(await p.$eval('.photo-viewer__stage', e => getComputedStyle(e).touchAction === 'none' && e.getBoundingClientRect().height >= 300), '舞台是固定大小、touch-action:none');
    t.ok(await (await btn('－')).evaluate(b => b.disabled), '100% 時「－」是停用的');
    await click('＋');
    t.ok(await label() === '140%' && (await tf()).s === 1.4, '「＋」放大 1.4 倍（140%）');
    for (let i = 0; i < 12; i++) await click('＋');
    t.ok(await label() === '600%' && (await (await btn('＋')).evaluate(b => b.disabled)) && (await tf()).s === 6, '放大上限 600%，「＋」停用');
    for (let i = 0; i < 14; i++) await click('－');
    const home = await tf();
    t.ok(await label() === '100%' && home.s === 1 && home.x === 0 && home.y === 0, '縮回 100% 圖片置中歸位');

    // 滾輪
    let b = await stageBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.wheel({ deltaY: -300 });
    await t.sleep(100);
    t.ok((await tf()).s === 1, '一般滾輪不縮放（照常捲動頁面）');
    b = await centre();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.keyboard.down('Control'); await p.mouse.wheel({ deltaY: -100 }); await p.keyboard.up('Control');
    await t.sleep(150);
    const afterWheel = await tf();
    t.ok(afterWheel.s > 1, `Ctrl+滾輪放大（${afterWheel.s.toFixed(2)}）`);
    await click('還原');

    // 以游標點為不動點縮放
    b = await centre();
    const P = { x: b.x + b.width / 2 + 120, y: b.y + b.height / 2 + 60 };
    await p.mouse.move(P.x, P.y);
    const imgPt = async () => { const x = await tf(); const bb = await stageBox(); return { x: (P.x - (bb.x + bb.width / 2) - x.x) / x.s, y: (P.y - (bb.y + bb.height / 2) - x.y) / x.s }; };
    const before = await imgPt();
    await p.keyboard.down('Control'); await p.mouse.wheel({ deltaY: -120 }); await p.keyboard.up('Control');
    await t.sleep(200);
    const after = await imgPt();
    t.ok(Math.abs(before.x - after.x) < 1.5 && Math.abs(before.y - after.y) < 1.5 && (await tf()).s > 1, '縮放時游標底下的那一點固定不動');

    // 拖曳平移
    await click('＋'); await click('＋');
    const t0 = await tf();
    b = await centre();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2 + 40, { steps: 4 }); await p.mouse.up();
    await t.sleep(100);
    const t1 = await tf();
    t.ok(Math.abs(t1.x - t0.x - 80) < 2 && Math.abs(t1.y - t0.y - 40) < 2 && t1.s === t0.s, '放大後拖曳，圖片隨拖曳距離移動');
    t.ok(await p.$eval('.photo-viewer__stage', e => e.classList.contains('is-zoomed')), '放大時舞台有「可拖曳」的游標樣式');
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2 + 5000, b.y + b.height / 2, { steps: 3 }); await p.mouse.up();
    await t.sleep(100);
    const t2 = await tf();
    t.ok(Math.abs(t2.x) <= b.width * t2.s / 2 + 1, '平移有邊界（不能把圖片拉到無限遠）');
    await click('還原');

    // 雙擊
    b = await centre();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await t.sleep(40); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await t.sleep(200);
    t.ok(Math.abs((await tf()).s - 2.5) < 0.01, '雙擊放大到 250%');
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await t.sleep(40); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await t.sleep(200);
    t.ok((await tf()).s === 1, '再雙擊回到 100%');

    // 雙指捏合（合成 pointer events）
    await p.evaluate(() => {
      const s = document.querySelector('.photo-viewer__stage'); const r = s.getBoundingClientRect();
      window.__pinch = (d0, d1) => {
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const ev = (type, id, x) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: cy, bubbles: true, pointerType: 'touch' }));
        ev('pointerdown', 1, cx - d0 / 2); ev('pointerdown', 2, cx + d0 / 2); ev('pointermove', 1, cx - d1 / 2); ev('pointermove', 2, cx + d1 / 2); ev('pointerup', 1, cx - d1 / 2); ev('pointerup', 2, cx + d1 / 2);
      };
    });
    await p.evaluate(() => window.__pinch(100, 250)); await t.sleep(100);
    const pin = await tf();
    t.ok(Math.abs(pin.s - 2.5) < 0.05, `雙指張開依手指距離比例放大（${pin.s.toFixed(2)}）`);
    await p.evaluate(() => window.__pinch(250, 50)); await t.sleep(100);
    t.ok((await tf()).s === 1, '雙指捏回超過 100% 會歸位置中');

    // 旋轉、還原
    await click('＋'); await click('↻');
    const rz = await tf();
    t.ok(rz.r === 90 && rz.s === 1.4, '旋轉與縮放並存（旋轉 90°、140%）');
    await click('還原');
    const rs = await tf();
    t.ok(rs.r === 0 && rs.s === 1 && rs.x === 0 && rs.y === 0, '「還原」同時還原縮放、位置與旋轉');

    // 鍵盤
    await p.mouse.move(5, 5);
    await p.keyboard.press('+'); await t.sleep(80);
    t.ok((await tf()).s === 1.4, '鍵盤 + 放大');
    await p.keyboard.press('-'); await t.sleep(80);
    t.ok((await tf()).s === 1, '鍵盤 − 縮小');
    await p.keyboard.press('+'); await p.keyboard.press('+'); await p.keyboard.press('0'); await t.sleep(80);
    t.ok((await tf()).s === 1, '鍵盤 0 還原');
    await p.keyboard.down('Control'); await p.keyboard.press('+'); await p.keyboard.up('Control'); await t.sleep(60);
    t.ok((await tf()).s === 1, 'Ctrl+加號留給瀏覽器（檢視器不處理）');
    await p.keyboard.press('Escape'); await t.sleep(100);
    t.ok(await p.$('.photo-viewer') === null, 'Esc 收合');
    await p.click('a[data-viewer]'); await t.sleep(150);
    t.ok(await p.$('.photo-viewer') !== null, '再點縮圖會重新開啟');
    await p.click('a[data-viewer].is-viewing'); await t.sleep(100);
    t.ok(await p.$('.photo-viewer') === null, '再點同一張縮圖會收合');

    // ---- 同一項目兩張照片：換張會重置縮放 ----
    await p.click(`a[data-viewer="viewer-${ctx.items[3]}"]`); await t.sleep(200);
    await click('＋'); await click('＋');
    t.ok((await tf()).s > 1.9, '第 1 張放大了');
    await click('下一張'); await t.sleep(200);
    t.ok(await label() === '100%' && (await tf()).s === 1, '換到下一張時回到 100%（縮放是每張各自的）');
    t.ok(/2 \/ 2/.test(await p.$eval('.photo-viewer__title', e => e.textContent)), '標題顯示 2 / 2');
    await p.keyboard.press('ArrowLeft'); await t.sleep(200);
    t.ok(/1 \/ 2/.test(await p.$eval('.photo-viewer__title', e => e.textContent)), '方向鍵切換上一張');

    // ---- 填寫頁 ----
    await t.go(p, `/batches/${ctx.bid}/entry`);
    await p.click('a[data-viewer]'); await p.waitForSelector('.photo-viewer__img:not([hidden])'); await click('＋');
    t.ok((await tf()).s === 1.4 && (await p.$$('.photo-viewer__btn')).length >= 6, '填寫頁：同一個檢視器、有縮放控制');
    await p.keyboard.press('Escape');

    // ---- 手機寬度：檢視區不能比螢幕寬 ----
    await p.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
    for (const url of [`/batches/${ctx.bid}`, `/batches/${ctx.bid}/entry`]) {
      await t.go(p, url); await p.click('a[data-viewer]'); await t.sleep(300);
      const mb = await p.$eval('.photo-viewer__stage', e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
      t.ok(mb.l >= 0 && mb.r <= 376 && await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `手機 ${url}：檢視區在螢幕範圍內（${Math.round(mb.l)}→${Math.round(mb.r)} / 375）`);
    }
  },
};
