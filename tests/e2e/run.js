#!/usr/bin/env node
// 端到端測試的執行器。用法與說明見 tests/e2e/README.md
//   npm run test:e2e                      跑全部
//   npm run test:e2e -- --only deletion   只跑名稱含 deletion 的
//   npm run test:e2e -- --list            列出所有測試
//   npm run test:e2e -- --verbose         連通過的檢查都印出來
//   npm run test:e2e -- --keep            測完保留沙盒（排查問題用）
const fs = require('fs');
const path = require('path');
const { findChrome, hasTool } = require('./lib/chrome');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const specDir = path.join(__dirname, 'specs');
const files = fs.readdirSync(specDir).filter(f => f.endsWith('.e2e.js')).sort();
const only = (opt('only') || '').split(',').map(s => s.trim()).filter(Boolean);
const selected = files.filter(f => !only.length || only.some(o => f.includes(o)));

if (flag('list')) { files.forEach(f => console.log(f.replace('.e2e.js', ''))); process.exit(0); }
if (!selected.length) { console.error(`找不到符合 ${only.join(',')} 的測試。用 --list 看有哪些。`); process.exit(2); }

// 專案的原生套件（better-sqlite3 等）是用 Node 20 編譯的；用別的版本會載入失敗，先講清楚
try { new (require('better-sqlite3'))(':memory:').close(); } catch (e) {
  console.error(`無法載入 better-sqlite3（目前 Node ${process.version}）：${e.message.split('\n')[0]}\n請改用專案要求的 Node 20 執行，例如：\n  PATH=/opt/homebrew/opt/node@20/bin:$PATH npm run test:e2e`);
  process.exit(2);
}

(async () => {
  const { Sandbox } = require('./lib/sandbox');
  const { T } = require('./lib/context');
  const chrome = findChrome();
  const tools = { chrome: !!chrome, poppler: hasTool('pdfimages') && hasTool('pdfinfo') && hasTool('pdftotext') };
  console.log(`Node ${process.version}｜Chrome：${chrome || '找不到（需要瀏覽器的測試會略過；可用 CHROME_PATH 指定）'}｜poppler：${tools.poppler ? '有' : '沒有（PDF 內容檢查會略過）'}`);

  const sandbox = new Sandbox({ keep: flag('keep') });
  console.log(`建立沙盒 ${sandbox.root} …`);
  let browser = null;
  const results = [];
  try {
    await sandbox.prepare();
    if (chrome) {
      const puppeteer = require('puppeteer-core');
      browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--hide-scrollbars'] });
    }
    for (const f of selected) {
      const spec = require(path.join(specDir, f));
      const label = f.replace('.e2e.js', '');
      console.log(`\n▶ ${label}｜${spec.name}`);
      if (spec.needs && spec.needs.includes('browser') && !browser) { console.log('  略過：需要 Chrome'); results.push({ label, skipped: 'no chrome' }); continue; }
      if (spec.needs && spec.needs.includes('poppler') && !tools.poppler) { console.log('  略過：需要 poppler（pdfimages／pdfinfo／pdftotext）'); results.push({ label, skipped: 'no poppler' }); continue; }
      await sandbox.reset();
      const t = new T({ sandbox, browser, tools, verbose: flag('verbose') });
      const started = Date.now();
      let crashed = null;
      try { await spec.run(t); } catch (e) { crashed = e; t.failed.push(`測試中途出錯：${e.message}`); console.log(`    ✗ 測試中途出錯：${e.stack.split('\n').slice(0, 4).join('\n      ')}`); }
      if (!crashed && spec.checkPageErrors !== false) t.ok(t.pageErrors.length === 0, `頁面沒有 JavaScript 錯誤${t.pageErrors.length ? '：' + t.pageErrors.slice(0, 3).join('；') : ''}`);
      await t.closeBrowserContexts();
      t.unloadModules();
      results.push({ label, passed: t.passed, failed: t.failed, secs: ((Date.now() - started) / 1000).toFixed(1) });
      console.log(`  ${t.failed.length ? '✗' : '✓'} ${t.passed} 項通過${t.failed.length ? `，${t.failed.length} 項失敗` : ''}（${results[results.length - 1].secs} 秒）`);
    }
  } finally {
    if (browser) await browser.close();
    await sandbox.destroy();
  }
  const ran = results.filter(r => !r.skipped);
  const failed = ran.filter(r => r.failed.length);
  console.log(`\n==== 總結 ====`);
  for (const r of results) console.log(`${r.skipped ? '－' : (r.failed.length ? '✗' : '✓')} ${r.label}${r.skipped ? `（略過：${r.skipped}）` : `：${r.passed} 通過${r.failed.length ? `、${r.failed.length} 失敗` : ''}`}`);
  console.log(`${ran.reduce((a, r) => a + r.passed, 0)} 項通過，${failed.reduce((a, r) => a + r.failed.length, 0)} 項失敗，${results.length - ran.length} 個略過`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
