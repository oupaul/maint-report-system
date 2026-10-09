// 使用者的「預設簽名」：簽名時可以直接選用自己存過的簽名，不用每次重畫。
// 獨立一張表（一人一筆、PNG 圖檔存 BLOB），不放在 users 裡：users 常被 SELECT * 整表讀出（使用者清單等），
// 不要讓每一筆都帶著一張圖。簽名只有本人能取用（GET /account/signature.png），已簽署批次上的簽名仍是各自獨立的檔案，
// 之後刪除或更換預設簽名不影響已簽的批次與報告。
module.exports = async function migrate_0017_user_signatures(db) {
  db.exec(`
    CREATE TABLE user_signatures (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      image      BLOB NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
};
