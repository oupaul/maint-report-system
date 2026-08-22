// M365（Azure AD / Entra ID）SSO：帳號仍由管理員在「使用者管理」預先建立，
// 只是額外記錄一個 m365_email 用來比對登入者。允許多筆 NULL（尚未設定 SSO
// 的本地帳號），但已設定的 m365_email 之間必須唯一，避免兩個帳號對應同一個
// M365 使用者、登入時比對到錯的人。

module.exports = async function migrate_0004_m365_sso(db) {
  db.exec(`
    ALTER TABLE users ADD COLUMN m365_email TEXT;

    CREATE UNIQUE INDEX idx_users_m365_email
      ON users(m365_email)
      WHERE m365_email IS NOT NULL;
  `);
};
