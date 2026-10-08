// Email 通知：全部是新增表與新增欄位，不重建既有資料表。
// - mail_settings（單一列）：寄信方式（SMTP 或 M365 Graph）與設定，在網頁上維護，不用改設定檔、不用重啟服務。
//   SMTP 密碼 / M365 Client Secret 一律加密後才存（AES-256-GCM，見 utils/secretBox.js），網頁絕不回傳明碼。
//   app_url 是信件裡「前往查看」連結要用的系統網址。
// - users.email：收通知信的信箱（沒填就退而求其次用 m365_email）。
// - notifications.email_status / email_error：每一則站內通知對應的 Email 寄送結果
//   （sent 已寄出 / failed 失敗 / skipped 沒寄），管理員能在「Email 通知」頁看到並重寄失敗的。
module.exports = async function migrate_0011_email_notifications(db) {
  db.exec(`
    CREATE TABLE mail_settings (
      id                     INTEGER PRIMARY KEY,
      enabled                INTEGER NOT NULL DEFAULT 0,
      method                 TEXT NOT NULL DEFAULT 'smtp',
      smtp_host              TEXT,
      smtp_port              INTEGER NOT NULL DEFAULT 587,
      smtp_secure            INTEGER NOT NULL DEFAULT 0,
      smtp_user              TEXT,
      smtp_pass_enc          TEXT,
      smtp_from              TEXT,
      smtp_allow_self_signed INTEGER NOT NULL DEFAULT 0,
      m365_tenant_id         TEXT,
      m365_client_id         TEXT,
      m365_client_secret_enc TEXT,
      m365_from_address      TEXT,
      app_url                TEXT,
      updated_at             TEXT
    );
    INSERT INTO mail_settings (id) VALUES (1);

    ALTER TABLE users ADD COLUMN email TEXT;
    ALTER TABLE notifications ADD COLUMN email_status TEXT NOT NULL DEFAULT 'skipped';
    ALTER TABLE notifications ADD COLUMN email_error TEXT;
  `);
};
