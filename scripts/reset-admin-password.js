#!/usr/bin/env node
// 在主機上重設管理員密碼（忘記密碼、或初始亂數密碼沒抄到時使用）：
//   npm run reset-admin-password            # 重設帳號 admin
//   npm run reset-admin-password -- alice   # 重設指定帳號
// 會產生新的亂數密碼印在終端機、標記為下次登入必須改密碼、並登出該帳號所有現有的登入。
// 需要能讀寫資料庫檔案的權限，請用服務執行帳號執行（例如 sudo -u <服務帳號> npm run ...）。
// 這支腳本不處理 session cookie，但 config 載入時會因為沒有 SESSION_SECRET 印出警告，
// 在主機上手動執行時看起來像出錯，所以先塞一個用不到的值。
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'reset-script-unused';
const argon2 = require('argon2');
const db = require('../src/models/db');
const User = require('../src/models/User');
const { generateRandomPassword } = require('../src/utils/password');

async function main() {
  const username = process.argv[2] || 'admin';
  const user = User.findByUsername(username);
  if (!user) {
    console.error(`找不到帳號：${username}`);
    process.exit(1);
  }

  const password = generateRandomPassword();
  User.updatePassword(user.id, await argon2.hash(password), { mustChange: true });
  // 啟用帳號（忘記密碼的同時帳號可能已被停用或鎖住），並讓舊的登入狀態全部失效
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(user.id);
  try {
    const rows = db.prepare('SELECT sid, sess FROM sessions').all();
    const del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    for (const row of rows) {
      try {
        const sess = JSON.parse(row.sess);
        if (sess.user && sess.user.id === user.id) del.run(row.sid);
      } catch (e) { /* 無法解析的 session 略過 */ }
    }
  } catch (e) { /* sessions 資料表尚未建立（服務還沒啟動過）就不用處理 */ }

  console.log('');
  console.log('============================================================');
  console.log('  密碼已重設（只會顯示這一次，請立即抄下來）');
  console.log(`    帳號： ${user.username}`);
  console.log(`    密碼： ${password}`);
  console.log('  登入後系統會要求你立刻改成自己的密碼。');
  console.log('============================================================');
  console.log('');
}

main().catch((err) => {
  console.error('重設失敗：', err.message);
  process.exit(1);
});
