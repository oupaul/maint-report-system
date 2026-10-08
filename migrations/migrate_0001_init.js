// 初始 schema：users / assets / checklist_items / inspection_batches /
// inspection_batch_assets / inspection_items，並種子 checklist_items 與預設 admin 帳號。

const argon2 = require('argon2');
const { generateRandomPassword } = require('../src/utils/password');

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
      must_change_password INTEGER NOT NULL DEFAULT 0,
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

  // 種子管理員帳號：初始密碼每次安裝都是新產生的亂數，不再用固定的 admin123
  // （repo 是公開的，固定密碼等於全世界都知道）。這個密碼只會在這裡印出一次，
  // 並且標記 must_change_password=1，第一次登入就必須改掉。
  // 自動化部署可以事先設 INITIAL_ADMIN_PASSWORD 指定，這種情況不印出來。
  const provided = process.env.INITIAL_ADMIN_PASSWORD;
  const initialPassword = provided || generateRandomPassword();
  const passwordHash = await argon2.hash(initialPassword);
  db.prepare(
    `INSERT INTO users (username, password_hash, display_name, role, is_active, must_change_password)
     VALUES (?, ?, ?, ?, 1, 1)`
  ).run('admin', passwordHash, '系統管理員', 'admin');

  if (!provided) {
    // BEGIN/END 標記給 deploy.sh 在整個部署流程最後再印一次用（避免這段訊息被後面
    // 大量輸出洗掉），請不要改動這兩行的文字。
    console.log('');
    console.log('INITIAL_ADMIN_PASSWORD_BANNER_BEGIN');
    console.log('============================================================');
    console.log('  系統管理員初始帳號（只會顯示這一次，請立即抄下來）');
    console.log('    帳號： admin');
    console.log(`    密碼： ${initialPassword}`);
    console.log('  首次登入後系統會要求你立刻改成自己的密碼。');
    console.log('  忘記的話可在主機上執行 npm run reset-admin-password 重設。');
    console.log('============================================================');
    console.log('INITIAL_ADMIN_PASSWORD_BANNER_END');
    console.log('');
  }
};
