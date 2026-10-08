const nodemailer = require('nodemailer');

const db = require('../models/db');
const Notification = require('../models/Notification');
const secretBox = require('../utils/secretBox');
const { nowTaipei } = require('../utils/time');

// Email 通知（比照 expense-platform）：寄信方式有兩種——SMTP（帳號密碼），或 Microsoft 365 Graph
// （應用程式權限，client credentials）。設定放資料庫、在網頁上維護，機密加密儲存。
// 寄信永遠不會讓觸發它的動作失敗：站內通知先寫進資料庫，Email 是額外的即時提醒，
// 寄送結果（成功／失敗／沒寄）寫回同一筆通知，管理員在「Email 通知」頁看得到、失敗的可以重寄。

const SITE_NAME = '維護巡檢報告系統';
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const GUID_RE = /^[0-9a-fA-F-]{36}$/;

// ---------- 設定 ----------

function getRow() {
  return db.prepare('SELECT * FROM mail_settings WHERE id = 1').get();
}

function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

// 寄件人可以是「email」或「顯示名稱 <email>」
function isValidFrom(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  const m = /^[^<>"]*<([^<>\s]+)>$/.exec(v);
  return isValidEmail(m ? m[1] : v);
}

// 給畫面用：絕不含明碼，只回「有沒有設定」以及「已儲存的機密還解不解得開」
function settingsForView() {
  const r = getRow();
  const smtpPass = r.smtp_pass_enc ? secretBox.decrypt(r.smtp_pass_enc) : null;
  const m365Secret = r.m365_client_secret_enc ? secretBox.decrypt(r.m365_client_secret_enc) : null;
  return {
    enabled: !!r.enabled,
    method: r.method,
    smtp_host: r.smtp_host || '',
    smtp_port: r.smtp_port,
    smtp_secure: !!r.smtp_secure,
    smtp_user: r.smtp_user || '',
    smtp_from: r.smtp_from || '',
    smtp_allow_self_signed: !!r.smtp_allow_self_signed,
    m365_tenant_id: r.m365_tenant_id || '',
    m365_client_id: r.m365_client_id || '',
    m365_from_address: r.m365_from_address || '',
    app_url: r.app_url || '',
    hasSmtpPass: !!r.smtp_pass_enc,
    smtpPassUnreadable: !!r.smtp_pass_enc && smtpPass === null,
    hasM365Secret: !!r.m365_client_secret_enc,
    m365SecretUnreadable: !!r.m365_client_secret_enc && m365Secret === null,
  };
}

// 目前實際要用的寄信設定（含解密後的機密）；沒啟用或不完整回傳 null。
// requireEnabled=false 給「測試寄信」用：設定填完整就能測，不用先打開總開關。
function activeConfig({ requireEnabled = true } = {}) {
  const r = getRow();
  if (requireEnabled && !r.enabled) return null;
  if (r.method === 'm365') {
    const secret = r.m365_client_secret_enc ? secretBox.decrypt(r.m365_client_secret_enc) : null;
    if (!r.m365_tenant_id || !r.m365_client_id || !secret || !isValidEmail(r.m365_from_address || '')) return null;
    return { method: 'm365', tenantId: r.m365_tenant_id, clientId: r.m365_client_id, clientSecret: secret, from: r.m365_from_address };
  }
  if (!r.smtp_host || !r.smtp_from) return null;
  let pass = null;
  if (r.smtp_user) {
    pass = r.smtp_pass_enc ? secretBox.decrypt(r.smtp_pass_enc) : null;
    if (pass === null) return null;
  }
  return {
    method: 'smtp', host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure,
    user: r.smtp_user || null, pass, from: r.smtp_from, allowSelfSigned: !!r.smtp_allow_self_signed,
  };
}

function isReady() {
  return !!activeConfig();
}

// 驗證並整理使用者送出的設定。機密欄位留空 = 保留原本已儲存的（不是清空）。
function validateSettings(input) {
  const existing = getRow();
  const method = input.method === 'm365' ? 'm365' : 'smtp';
  const enabled = input.enabled === 'on';

  let appUrl = (input.app_url || '').trim().replace(/\/+$/, '');
  if (appUrl) {
    if (appUrl.length > 200 || !/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(appUrl)) {
      return { error: '系統網址格式不正確，請填完整網址，例如 https://maint.example.com' };
    }
  }

  const v = {
    enabled, method, app_url: appUrl || null,
    smtp_host: (input.smtp_host || '').trim() || null,
    smtp_port: parseInt(input.smtp_port, 10) || 587,
    smtp_secure: input.smtp_secure === 'on' ? 1 : 0,
    smtp_user: (input.smtp_user || '').trim() || null,
    smtp_from: (input.smtp_from || '').trim() || null,
    smtp_allow_self_signed: input.smtp_allow_self_signed === 'on' ? 1 : 0,
    m365_tenant_id: (input.m365_tenant_id || '').trim() || null,
    m365_client_id: (input.m365_client_id || '').trim() || null,
    m365_from_address: (input.m365_from_address || '').trim() || null,
    smtp_pass_enc: existing.smtp_pass_enc,
    m365_client_secret_enc: existing.m365_client_secret_enc,
  };

  if (v.smtp_host && !/^[A-Za-z0-9.-]{1,253}$/.test(v.smtp_host)) return { error: 'SMTP 主機只能是主機名稱或 IP（不含空白或網址）' };
  if (!(v.smtp_port >= 1 && v.smtp_port <= 65535)) return { error: 'SMTP 埠號需介於 1 到 65535' };
  if (v.smtp_from && !isValidFrom(v.smtp_from)) return { error: '寄件人格式不正確，請填 email，或「顯示名稱 <email>」' };
  if (v.smtp_user && v.smtp_user.length > 200) return { error: 'SMTP 帳號太長' };
  if (v.m365_tenant_id && !(GUID_RE.test(v.m365_tenant_id) || /^[A-Za-z0-9.-]+$/.test(v.m365_tenant_id))) return { error: 'Tenant ID 格式不正確' };
  if (v.m365_client_id && !GUID_RE.test(v.m365_client_id)) return { error: 'Client ID 格式不正確（應該是 GUID）' };
  if (v.m365_from_address && !isValidEmail(v.m365_from_address)) return { error: 'M365 寄件信箱格式不正確' };

  if (typeof input.smtp_pass === 'string' && input.smtp_pass !== '') {
    if (input.smtp_pass.length > 500) return { error: 'SMTP 密碼太長' };
    v.smtp_pass_enc = secretBox.encrypt(input.smtp_pass);
  }
  if (typeof input.m365_client_secret === 'string' && input.m365_client_secret.trim() !== '') {
    if (input.m365_client_secret.length > 500) return { error: 'Client Secret 太長' };
    v.m365_client_secret_enc = secretBox.encrypt(input.m365_client_secret.trim());
  }

  if (enabled) {
    if (method === 'smtp') {
      if (!v.smtp_host || !v.smtp_from) return { error: '要啟用 Email 通知，請填寫 SMTP 主機與寄件人' };
      if (v.smtp_user && !v.smtp_pass_enc) return { error: '有填 SMTP 帳號時需要同時填密碼' };
    } else if (!v.m365_tenant_id || !v.m365_client_id || !v.m365_from_address || !v.m365_client_secret_enc) {
      return { error: '要啟用 Email 通知，請完整填寫 M365 的 Tenant ID、Client ID、Client Secret 與寄件信箱' };
    }
  }
  return { value: v };
}

function saveSettings(v) {
  db.prepare(
    `UPDATE mail_settings SET enabled = ?, method = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?,
       smtp_pass_enc = ?, smtp_from = ?, smtp_allow_self_signed = ?, m365_tenant_id = ?, m365_client_id = ?,
       m365_client_secret_enc = ?, m365_from_address = ?, app_url = ?, updated_at = ? WHERE id = 1`
  ).run(
    v.enabled ? 1 : 0, v.method, v.smtp_host, v.smtp_port, v.smtp_secure, v.smtp_user,
    v.smtp_pass_enc, v.smtp_from, v.smtp_allow_self_signed, v.m365_tenant_id, v.m365_client_id,
    v.m365_client_secret_enc, v.m365_from_address, v.app_url, nowTaipei()
  );
  graphToken = null; // 設定改了，舊的 access token 作廢
}

// ---------- 錯誤訊息（翻成管理員看得懂、知道怎麼修的說明） ----------

function formatMailError(err) {
  const raw = err && err.message ? err.message : String(err);
  const code = err && err.code;
  if (code === 'EAUTH' || /535|Invalid login|authentication failed/i.test(raw)) {
    return 'SMTP 登入失敗：帳號或密碼不正確（Microsoft 365 / Gmail 通常需要「應用程式密碼」，且可能已停用基本驗證）';
  }
  if (code === 'ECONNREFUSED') return '連不上 SMTP 主機：連線被拒絕，請確認主機位址與埠號';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' && /timeout/i.test(raw)) return '連線 SMTP 主機逾時，請確認主機位址、埠號與防火牆';
  if (code === 'ENOTFOUND' || code === 'EDNS') return '找不到 SMTP 主機名稱，請確認拼字與 DNS';
  if (/self.signed|unable to verify|certificate/i.test(raw)) return 'SMTP 主機的憑證不被信任（自簽或內部 CA 憑證）。若確定是自己的內部主機，可勾選「信任自我簽署憑證」';
  if (/wrong version number|ssl routines/i.test(raw)) return 'SSL/TLS 設定與埠號不符：465 埠通常要勾選「使用 SSL/TLS」，587 埠則不勾（會自動升級加密）';
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

// ---------- 寄送 ----------

let graphToken = null; // { token, expiresAt }

async function getGraphToken(cfg) {
  if (graphToken && graphToken.expiresAt > Date.now() + 60 * 1000) return graphToken.token;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    const code = /AADSTS(\d+)/.exec(detail);
    let hint = '';
    if (code && code[1] === '7000215') hint = '（Client Secret 不正確，請注意要填「值」而不是「密碼識別碼」）';
    else if (code && code[1] === '7000222') hint = '（Client Secret 已過期，請到 Azure 重新建立）';
    else if (code && code[1] === '700016') hint = '（找不到這個 Client ID，請確認 Client ID 與 Tenant ID）';
    throw new Error(`取得 Microsoft Graph 存取權杖失敗${hint}：${String(detail).split('\r')[0].slice(0, 200)}`);
  }
  graphToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return graphToken.token;
}

async function sendViaGraph(cfg, { to, subject, text, html }) {
  const token = await getGraphToken(cfg);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 202 || res.ok) return;
  if (res.status === 401) graphToken = null;
  const data = await res.json().catch(() => ({}));
  const err = (data.error && (data.error.message || data.error.code)) || `HTTP ${res.status}`;
  let hint = '';
  if (res.status === 403 || /Access is denied|ErrorAccessDenied/i.test(err)) hint = '（這個應用程式沒有 Mail.Send「應用程式權限」，或管理員尚未「代表組織授與同意」）';
  else if (res.status === 404 || /MailboxNotEnabled|ResourceNotFound|does not exist/i.test(err)) hint = '（找不到寄件信箱，或該信箱沒有 Exchange Online 授權）';
  throw new Error(`Microsoft Graph 寄信失敗${hint}：${String(err).slice(0, 200)}`);
}

async function sendViaSmtp(cfg, { to, subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    // 內部郵件主機常用自簽／內部 CA 憑證：預設維持憑證驗證，只有管理員明確勾選才關掉
    tls: { rejectUnauthorized: !cfg.allowSelfSigned },
    // 有些自架郵件主機會先做反解／RBL 查詢才送 greeting，預設逾時太短；抓寬一點但不要卡住請求太久
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });
  try {
    await transporter.sendMail({ from: cfg.from, to, subject, text, ...(html ? { html } : {}) });
  } finally {
    transporter.close();
  }
}

// 回傳 { status: 'sent' } | { status: 'failed', error } | { status: 'skipped', error }
async function sendMail(message, { requireEnabled = true } = {}) {
  const cfg = activeConfig({ requireEnabled });
  if (!cfg) return { status: 'skipped', error: '寄信功能尚未啟用，或設定不完整' };
  try {
    if (cfg.method === 'm365') await sendViaGraph(cfg, message);
    else await sendViaSmtp(cfg, message);
    return { status: 'sent' };
  } catch (err) {
    console.error(`[Email] 寄送失敗（收件人 ${message.to}）：${err.message}`);
    return { status: 'failed', error: formatMailError(err) };
  }
}

// ---------- 信件內容 ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderEmail({ title, message, linkUrl }) {
  const text = [title, '', message, ...(linkUrl ? ['', `前往查看：${linkUrl}`] : []), '', `— ${SITE_NAME}（自動發送，請勿直接回覆）`].join('\n');
  const html = `<!doctype html><html lang="zh-Hant"><body style="margin:0;padding:24px;background:#F8FAFC;font-family:-apple-system,'Segoe UI','Noto Sans TC',sans-serif;color:#1E293B;">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;">
<tr><td style="background:#1E293B;color:#fff;padding:16px 24px;font-weight:700;">${esc(SITE_NAME)}</td></tr>
<tr><td style="padding:24px;">
<h2 style="margin:0 0 12px;font-size:18px;">${esc(title)}</h2>
<p style="margin:0 0 20px;line-height:1.7;white-space:pre-wrap;">${esc(message)}</p>
${linkUrl ? `<a href="${esc(linkUrl)}" style="display:inline-block;background:#F97316;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">前往查看</a>` : ''}
</td></tr>
<tr><td style="padding:12px 24px;color:#64748B;font-size:12px;border-top:1px solid #E2E8F0;">這是系統自動發送的通知信，請勿直接回覆。</td></tr>
</table></body></html>`;
  return { text, html };
}

function recipientFor(user) {
  const email = (user && (user.email || user.m365_email) || '').trim();
  return isValidEmail(email) ? email : null;
}

// ---------- 通知信 ----------

async function deliverNotification(id) {
  const n = Notification.findById(id);
  if (!n) return; // 交易被還原、通知不存在
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(n.user_id);
  const to = recipientFor(user);
  if (!to) {
    Notification.setEmailResult(id, 'skipped', '這位使用者沒有設定 Email');
    return;
  }
  if (!isReady()) {
    Notification.setEmailResult(id, 'skipped', '寄信功能尚未啟用，或設定不完整');
    return;
  }
  const appUrl = getRow().app_url;
  const linkUrl = appUrl ? `${appUrl}${n.batch_id ? `/batches/${n.batch_id}` : '/notifications'}` : null;
  const { text, html } = renderEmail({ title: n.title, message: n.message, linkUrl });
  // 標題裡含批次名稱（使用者輸入），換行一律換成空白：避免信件標頭被截斷或夾帶額外標頭
  const subject = `【${SITE_NAME}】${String(n.title).replace(/[\r\n]+/g, ' ')}`;
  const result = await sendMail({ to, subject, text, html });
  Notification.setEmailResult(id, result.status, result.error || null);
}

// 站內通知寫進資料庫之後呼叫。放到下一個 tick 才寄，確保呼叫端的資料庫交易已經提交；
// 寄信是背景作業，不影響也不拖慢使用者的操作，任何錯誤都只記在那筆通知上。
function queueNotificationEmail(id) {
  setImmediate(() => {
    deliverNotification(id).catch((err) => {
      console.error('[Email] 通知信處理失敗：', err);
      try { Notification.setEmailResult(id, 'failed', formatMailError(err)); } catch (e) { /* ignore */ }
    });
  });
}

async function resend(id) {
  const n = Notification.findById(id);
  if (!n) return { ok: false, error: '找不到這則通知' };
  await deliverNotification(id);
  const after = Notification.findById(id);
  return after.email_status === 'sent' ? { ok: true } : { ok: false, error: after.email_error || '寄送失敗' };
}

async function sendTest(to) {
  if (!isValidEmail(to)) return { status: 'failed', error: '收件人 Email 格式不正確' };
  const { text, html } = renderEmail({
    title: '測試信',
    message: `這是一封來自${SITE_NAME}的測試信。如果你收到了，代表 Email 通知的寄信設定正確。\n\n發送時間：${nowTaipei()}（台北時間）`,
    linkUrl: getRow().app_url || null,
  });
  return sendMail({ to: to.trim(), subject: `【${SITE_NAME}】測試信`, text, html }, { requireEnabled: false });
}

// 近 N 小時寄送失敗的通知數（系統狀態頁的健康檢查用）
function recentFailures(hours = 24) {
  const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - hours * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE email_status = 'failed' AND created_at >= ?").get(cutoff).n;
}

module.exports = {
  isValidEmail, isValidFrom, recipientFor,
  settingsForView, validateSettings, saveSettings, isReady,
  sendMail, deliverNotification, queueNotificationEmail, resend, sendTest, recentFailures, renderEmail,
};
