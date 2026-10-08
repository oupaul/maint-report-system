// 既有安裝（在「初始密碼改成隨機產生」之前建立的）升級用：
// 1. 補上 users.must_change_password 欄位（全新安裝已經在 0001 建好，所以先檢查）
// 2. 找出「密碼仍是舊預設值 admin123」的帳號，標記成下次登入強制改密碼——
//    repo 是公開的，這個預設密碼全世界都知道，既有主機不能繼續放著不管。
//    已經自己改過密碼的帳號不受影響。
const argon2 = require('argon2');

const LEGACY_DEFAULT_PASSWORD = 'admin123';

module.exports = async function migrate_0005_password_policy(db) {
  const columns = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!columns.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }

  const users = db.prepare('SELECT id, username, password_hash FROM users').all();
  const flag = db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?');
  for (const user of users) {
    let isLegacyDefault = false;
    try {
      isLegacyDefault = await argon2.verify(user.password_hash, LEGACY_DEFAULT_PASSWORD);
    } catch (err) {
      // 雜湊格式無法解析就當作不是預設密碼
    }
    if (isLegacyDefault) {
      flag.run(user.id);
      console.log(`  ⚠ 帳號 ${user.username} 仍在使用預設密碼，已標記為下次登入強制改密碼`);
    }
  }
};
