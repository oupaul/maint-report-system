#!/usr/bin/env node
// Migration runner — 依序執行 migrations/，以 schema_migrations 追蹤已執行項目
// 新增 migration 時只需在 MIGRATIONS 陣列末尾加一行，runner 自動只跑新的。
// 陣列順序即執行順序，只能在尾端新增，不可調整既有項目的位置。

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'maint_report.db');

// 依執行順序排列 — 只能在最後新增，不可改變已有項目的位置
const MIGRATIONS = [
  'migrate_0001_init',
  'migrate_0002_multi_photos',
  'migrate_0003_batch_signatures',
  'migrate_0004_m365_sso',
  'migrate_0005_password_policy',
  'migrate_0006_backup_and_activity',
  'migrate_0007_branding',
];

async function run() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )
  `);

  const done = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name)
  );

  const pending = MIGRATIONS.filter(m => !done.has(m));

  if (pending.length === 0) {
    console.log('✓ 所有 migration 均已執行，無需更新');
    db.close();
    return;
  }

  if (done.size === 0) {
    console.log(`執行 ${pending.length} 個 migration...`);
  } else {
    console.log(`發現 ${pending.length} 個新 migration：`);
    pending.forEach(m => console.log(`  + ${m}`));
    console.log('');
  }

  let success = 0;
  let failed = 0;
  const failedList = [];

  for (const name of pending) {
    const modPath = path.join(__dirname, `${name}.js`);
    if (!fs.existsSync(modPath)) {
      console.warn(`[警告] 找不到 migration 檔案: ${name}.js，跳過`);
      continue;
    }

    const migration = require(modPath);
    const fn = typeof migration === 'function' ? migration : migration.up;

    if (typeof fn !== 'function') {
      console.warn(`[警告] ${name}.js 未匯出可執行的函式，跳過`);
      continue;
    }

    // 個別 migration 可能是 async（例如需要 argon2 hash 密碼），
    // better-sqlite3 的 db.transaction() 只支援同步 callback，
    // 因此這裡手動用 BEGIN/COMMIT/ROLLBACK 包裹，允許 fn 回傳 Promise。
    db.exec('BEGIN');
    try {
      await fn(db);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
      console.log(`✓ ${name}`);
      success++;
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`[錯誤] ${name} 執行失敗: ${err.message}`);
      failed++;
      failedList.push(name);
    }
  }

  db.close();

  console.log('');
  if (failed === 0) {
    console.log(`✓ migration 完成：執行 ${success} 個`);
  } else {
    console.log(`migration 完成：${success} 個成功，${failed} 個失敗（${failedList.join(', ')}）`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[致命錯誤] migration runner 執行失敗:', err);
  process.exit(1);
});
