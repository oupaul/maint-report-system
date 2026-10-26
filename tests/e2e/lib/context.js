// 每個測試檔拿到的 t：檢查（ok）、資料庫、登入與頁面操作、造資料（fixtures）、PDF 工具。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { PASSWORD } = require('./sandbox');

const NOW = '2026-10-19 09:00:00';

class T {
  constructor({ sandbox, browser, tools, verbose }) {
    this.sandbox = sandbox;
    this.browser = browser;
    this.tools = tools;
    this.verbose = verbose;
    this.passed = 0;
    this.failed = [];
    this.pageErrors = [];
    this.contexts = [];
    this.tmpDir = path.join(sandbox.root, 'tmp');
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.PASSWORD = PASSWORD;
    this.NOW = NOW;
    this.n = 0;
  }

  get base() { return this.sandbox.base; }
  get root() { return this.sandbox.root; }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------- 檢查 ----------
  ok(cond, msg) {
    if (cond) { this.passed++; if (this.verbose) console.log(`    ✓ ${msg}`); }
    else { this.failed.push(msg); console.log(`    ✗ ${msg}`); }
    return !!cond;
  }

  // ---------- 資料庫（直接讀寫沙盒的 SQLite；每次開新連線，伺服器那邊即時看得到） ----------
  q(sql, ...args) {
    const db = new Database(this.sandbox.dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      const st = db.prepare(sql);
      return st.reader ? st.all(...args) : st.run(...args);
    } finally { db.close(); }
  }
  count(table, where, ...args) { return this.q(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args)[0].n; }
  uid(username) { return this.q('SELECT id FROM users WHERE username = ?', username)[0].id; }

  // 載入沙盒裡的專案模組（例如 src/services/ImageService）
  require(rel) {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'e2e';
    return require(path.join(this.root, rel));
  }

  // ---------- 瀏覽器 ----------
  async login(username, password = PASSWORD, { width = 1300, height = 900 } = {}) {
    if (!this.browser) throw new Error('這個測試需要瀏覽器（Chrome），目前沒有');
    const ctx = await this.browser.createBrowserContext();
    this.contexts.push(ctx);
    const page = await ctx.newPage();
    await page.setViewport({ width, height });
    page.on('pageerror', (e) => this.pageErrors.push(`${username}: ${e.message}`));
    page.on('dialog', (d) => d.accept());
    await page.goto(`${this.base}/login`);
    await page.type('#username', username);
    await page.type('#password', password);
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
    return page;
  }
  go(page, url) { return page.goto(`${this.base}${url}`, { waitUntil: 'networkidle0' }); }

  // 在頁面裡用 fetch 送 POST（自動帶頁面上的 CSRF token）；回傳 { status, url, text }（text 已去掉 HTML 標籤）
  post(page, url, body = '') {
    return page.evaluate(async (url, body) => {
      const el = document.querySelector('input[name=_csrf]');
      if (!el) throw new Error('這個頁面沒有 CSRF 欄位，請先 go() 到有表單的頁面');
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + encodeURIComponent(el.value) + (body ? '&' + body : ''), redirect: 'follow' });
      return { status: r.status, url: r.url, text: (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
    }, url, body);
  }
  async cookieHeader(page) {
    const cookies = page.browserContext ? await page.browserContext().cookies() : await page.cookies();
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }
  // 以頁面的登入身分下載（PDF、CSV、ZIP…）
  async download(page, url) {
    const r = await fetch(`${this.base}${url}`, { headers: { Cookie: await this.cookieHeader(page) }, redirect: 'manual' });
    return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', cache: r.headers.get('cache-control') || '', buf: Buffer.from(await r.arrayBuffer()) };
  }
  // 沙盒模組（models/db 會開著資料庫連線）在測試行程內被快取；reset() 會換掉資料庫檔，
  // 所以每個 spec 結束都要關連線並清掉快取，下一個 spec 才會重新載入並連到新的資料庫。
  unloadModules() {
    const realRoot = fs.realpathSync(this.root);
    const root = realRoot + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (!key.startsWith(root)) continue;
      const exp = require.cache[key].exports;
      if (key === path.join(realRoot, 'src', 'models', 'db.js') && exp && typeof exp.close === 'function') { try { exp.close(); } catch (e) { /* 已關閉 */ } }
      delete require.cache[key];
    }
  }
  async closeBrowserContexts() { for (const c of this.contexts) { try { await c.close(); } catch (e) { /* 已關閉 */ } } this.contexts = []; }

  // ---------- 造資料 ----------
  mkCustomer(name, { taxId = null, code = null, active = 1 } = {}) {
    return this.q('INSERT INTO customers (name, tax_id, code, is_active, created_at) VALUES (?, ?, ?, ?, ?)', name, taxId, code, active, NOW).lastInsertRowid;
  }
  mkAsset(name, { category = 'server', customerId = null, location = '機房' } = {}) {
    return this.q('INSERT INTO assets (name, category, location, is_active, created_at, customer_id) VALUES (?, ?, ?, 1, ?, ?)', name, category, location, NOW, customerId).lastInsertRowid;
  }
  checklistIds(category = 'server', n = 2) {
    return this.q('SELECT id FROM checklist_items WHERE category = ? ORDER BY id LIMIT ?', category, n).map(r => r.id);
  }
  // 建一個批次：設備、檢查項目（可指定誰填的）、假的截圖檔、工程師簽名、通知
  mkBatch({ title, by = this.uid('wang'), status = 'draft', approval = 'none', assets = 2, photos = true, signature = false, recorders = [], customerIds = [] }) {
    const bid = this.q('INSERT INTO inspection_batches (title, batch_date, status, created_by, created_at, approval_status) VALUES (?, ?, ?, ?, ?, ?)', title, '2026-10-19', status, by, NOW, approval).lastInsertRowid;
    const dir = path.join(this.root, 'uploads', String(bid));
    fs.mkdirSync(dir, { recursive: true });
    const aids = [], files = [], itemIds = [];
    const cis = this.checklistIds('server', 2);
    for (let i = 0; i < assets; i++) {
      const a = this.mkAsset(`${title}-設備${++this.n}`, { customerId: customerIds[i % Math.max(customerIds.length, 1)] || null });
      aids.push(a);
      this.q('INSERT INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)', bid, a);
      cis.forEach((ci, k) => {
        const rec = recorders.length ? recorders[k % recorders.length] : null;
        const it = this.q('INSERT INTO inspection_items (batch_id, asset_id, checklist_item_id, status, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', bid, a, ci, 'normal', rec, NOW).lastInsertRowid;
        itemIds.push(it);
        if (photos) {
          const f = path.join(dir, `p-${it}.webp`);
          fs.writeFileSync(f, 'x');
          files.push(f);
          this.q("INSERT INTO inspection_item_photos (inspection_item_id, path, format, width, height, sort_order, uploaded_at) VALUES (?, ?, 'webp', 10, 10, 0, ?)", it, f, NOW);
        }
      });
    }
    if (signature) {
      const f = path.join(dir, 'signature-engineer.png');
      fs.writeFileSync(f, 'x');
      files.push(f);
      this.q("INSERT INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at) VALUES (?, 'engineer', ?, ?, ?)", bid, by, f, NOW);
    }
    this.q("INSERT INTO notifications (user_id, batch_id, type, title, message, created_at) VALUES (?, ?, 'submitted', 't', 'm', ?)", this.uid('admin'), bid, NOW);
    return { bid, aids, files, dir, itemIds, title };
  }
  // 假的工程師簽名（只驗「有沒有簽」的規則時用；要走真正的簽名路由請用 signatureDataUrl）
  signEngineer(bid, userId) {
    this.q("INSERT OR REPLACE INTO batch_signatures (batch_id, role, user_id, signature_path, signed_at) VALUES (?, 'engineer', ?, '/tmp/none.png', ?)", bid, userId, NOW);
  }
  async signatureDataUrl() {
    const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
    return 'data:image/png;base64,' + png.toString('base64');
  }

  // 滿是小字的「螢幕截圖」、像相機照片的雜訊 JPEG
  async shotPng(w, h, tag = 'A') {
    const size = Math.round(w / 110);
    const rows = Array.from({ length: Math.floor(h / (size * 1.7)) }, (_, i) =>
      `<text x="30" y="${40 + i * size * 1.7}" font-size="${size}" font-family="Menlo,monospace" fill="#111">${tag} ERP-DB01 C:\\ used 412.5 GB / total 500 GB  backup job ${i} OK  192.168.10.${i}</text>`).join('');
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${rows}</svg>`)).png().toBuffer();
  }
  async photoJpeg(w, h) {
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761 >>> 24) & 255;
    const blurred = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).blur(2).raw().toBuffer();
    return sharp(blurred, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  }
  // 走正式的上傳處理（ImageService）存一張真的截圖並掛到檢查項目上
  async storePhoto(bid, itemId, buf, mime, idx = 0) {
    const { processScreenshot } = this.require('src/services/ImageService');
    const r = await processScreenshot(buf, mime, path.join(this.root, 'uploads', String(bid), `seed-${itemId}-${idx}`));
    this.q('INSERT INTO inspection_item_photos (inspection_item_id, path, format, width, height, sort_order, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', itemId, r.path, r.format, r.width, r.height, idx, NOW);
    return r;
  }
  // 一個涵蓋兩家客戶、有真實截圖的批次：甲公司（統編 12345678）的 ERP-DB01 有 3 張、乙公司的 NAS-01 有 2 張（其中一個項目 2 張）
  async mkReportBatch({ title = '報告測試巡檢', by = this.uid('wang') } = {}) {
    const cA = this.mkCustomer('甲公司', { taxId: '12345678' });
    const cB = this.mkCustomer('乙公司');
    const a1 = this.mkAsset('ERP-DB01', { category: 'server', customerId: cA });
    const a2 = this.mkAsset('NAS-01', { category: 'nas', customerId: cB });
    const bid = this.q('INSERT INTO inspection_batches (title, batch_date, status, created_by, created_at) VALUES (?, ?, ?, ?, ?)', title, '2026-10-19', 'draft', by, NOW).lastInsertRowid;
    for (const a of [a1, a2]) this.q('INSERT INTO inspection_batch_assets (batch_id, asset_id) VALUES (?, ?)', bid, a);
    const items = [];
    for (const [a, cat] of [[a1, 'server'], [a2, 'nas']]) {
      for (const ci of this.q('SELECT id FROM checklist_items WHERE category = ? ORDER BY sort_order, id', cat)) {
        items.push(this.q('INSERT INTO inspection_items (batch_id, asset_id, checklist_item_id, status, recorded_at) VALUES (?, ?, ?, ?, ?)', bid, a, ci.id, 'normal', NOW).lastInsertRowid);
      }
    }
    const retina = await this.shotPng(2880, 1800, 'A');
    const screen = await this.shotPng(1366, 768, 'B');
    const phone = await this.photoJpeg(4032, 3024);
    await this.storePhoto(bid, items[0], retina, 'image/png');
    await this.storePhoto(bid, items[1], phone, 'image/jpeg');
    await this.storePhoto(bid, items[2], screen, 'image/png');
    await this.storePhoto(bid, items[3], await this.shotPng(2880, 1800, 'C'), 'image/png', 0);
    await this.storePhoto(bid, items[3], retina, 'image/png', 1);
    return { bid, cA, cB, a1, a2, items, title };
  }

  // ---------- PDF 工具（poppler：pdfimages / pdfinfo / pdftotext；沒裝就回 null，測試自己決定略過） ----------
  pdfImages(file) {
    return execFileSync('pdfimages', ['-list', file]).toString().trim().split('\n').slice(2).map(l => {
      const c = l.trim().split(/\s+/);
      return { page: +c[0], w: +c[3], h: +c[4], enc: c[8], ppi: +c[12] };
    });
  }
  pdfPages(file) { return +/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file]).toString())[1]; }
  pdfText(file) { return execFileSync('pdftotext', ['-layout', file, '-']).toString(); }
  tmpFile(name, buf) { const f = path.join(this.tmpDir, name); fs.writeFileSync(f, buf); return f; }
}

module.exports = { T, NOW };
