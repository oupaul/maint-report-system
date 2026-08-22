// 初始 schema：users / assets / checklist_items / inspection_batches /
// inspection_batch_assets / inspection_items，並種子 checklist_items 與預設 admin 帳號。

const argon2 = require('argon2');

const CHECKLIST_SEED = [
  // category, code, label, sort_order
  ['pc', 'disk_health', '硬碟健康狀態', 1],
  ['pc', 'disk_space', '磁碟空間', 2],
  ['pc', 'backup_status', '備份狀態', 3],
  ['server', 'disk_health', '硬碟健康狀態', 1],
  ['server', 'disk_space', '磁碟空間', 2],
  ['server', 'backup_status', '備份狀態', 3],
  ['nas', 'disk_health', '硬碟健康狀態', 1],
  ['nas', 'disk_space', '磁碟空間', 2],
  ['nas', 'backup_status', '備份狀態', 3],
  ['network_device', 'health_status', '健康狀態', 1],
  ['network_device', 'firmware_version', '韌體版本', 2],
];

module.exports = async function migrate_0001_init(db) {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','technician')),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE assets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('pc','server','nas','network_device')),
      location TEXT,
      identifier TEXT,
      notes TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE checklist_items (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('pc','server','nas','network_device')),
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(category, code)
    );

    CREATE TABLE inspection_batches (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      batch_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','completed')) DEFAULT 'draft',
      created_by INTEGER NOT NULL REFERENCES users(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE inspection_batch_assets (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES inspection_batches(id),
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      UNIQUE(batch_id, asset_id)
    );

    CREATE TABLE inspection_items (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES inspection_batches(id),
      asset_id INTEGER NOT NULL REFERENCES assets(id),
      checklist_item_id INTEGER NOT NULL REFERENCES checklist_items(id),
      status TEXT NOT NULL CHECK(status IN ('normal','warning','critical')),
      value_text TEXT,
      note TEXT,
      screenshot_path TEXT,
      screenshot_format TEXT,
      screenshot_width INTEGER,
      screenshot_height INTEGER,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','automated')),
      source_ref TEXT,
      recorded_by INTEGER REFERENCES users(id),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(batch_id, asset_id, checklist_item_id)
    );
  `);

  const insertChecklist = db.prepare(
    'INSERT INTO checklist_items (category, code, label, sort_order) VALUES (?, ?, ?, ?)'
  );
  for (const row of CHECKLIST_SEED) {
    insertChecklist.run(...row);
  }

  // 種子預設管理員帳號（admin / admin123）— 沿用 pbg-system 慣例，首次登入後應立即改密碼
  const passwordHash = await argon2.hash('admin123');
  db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, is_active)
     VALUES (?, ?, ?, ?, 1)`
  ).run('admin', passwordHash, '系統管理員', 'admin');
};
