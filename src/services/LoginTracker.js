// 記錄「誰什麼時候登入、用了多久」（資料表 login_sessions，規則見 migration 0024 與 models/LoginSession.js）。
// 不是每個請求都寫資料庫：記憶體裡記每個登入最後一次操作的時間，同一個登入最多每分鐘寫一次 last_seen_at。
// 記錄失敗絕不影響使用者操作（全部包 try/catch）。
const crypto = require('crypto');
const LoginSession = require('../models/LoginSession');
const ActivityTracker = require('./ActivityTracker');
const { nowTaipei, formatTaipei } = require('../utils/time');

const WRITE_EVERY_MS = 60 * 1000;
// 前端背景輪詢（通知）不算「使用」，否則畫面開著沒人操作也永遠不會閒置
const IGNORED_PATHS = new Set(['/notifications/status']);

const state = new Map(); // session_key -> { id, lastSeen(ms), lastWrite(ms) }
let lastPrune = 0;

const keyOf = (sessionID) => crypto.createHash('sha256').update(String(sessionID)).digest('hex').slice(0, 32);

function open({ userId, sessionID, ip, userAgent }, method) {
  const key = keyOf(sessionID);
  const id = LoginSession.create({ userId, key, method, ip: ip || null, agent: ActivityTracker.describeAgent(userAgent) });
  const now = Date.now();
  const st = { id, lastSeen: now, lastWrite: now };
  state.set(key, st);
  maybePrune(now);
  return st;
}

function maybePrune(now) {
  if (now - lastPrune < 24 * 3600 * 1000) return;
  lastPrune = now;
  try { LoginSession.prune(); } catch (e) { /* 清不掉不影響服務 */ }
}

// 登入成功時呼叫（utils/session.js 的 establishSession，session id 已經換成新的）
function start(req, user, method) {
  try {
    open({ userId: user.id, sessionID: req.sessionID, ip: req.ip, userAgent: req.get && req.get('user-agent') }, method);
  } catch (e) { /* 只是記錄用 */ }
}

// 每個登入後的請求：更新最後操作時間；閒置超過 30 分鐘就結束上一段、開新的一段
function touch(req) {
  try {
    if (!req.user || !req.sessionID || IGNORED_PATHS.has(req.path)) return;
    const key = keyOf(req.sessionID);
    const now = Date.now();
    let st = state.get(key);
    if (!st) { // 服務重啟過、或這個登入早於這個功能：從資料庫接回
      const row = LoginSession.findOpenByKey(key);
      if (row) st = { id: row.id, lastSeen: LoginSession.toMs(row.last_seen_at), lastWrite: LoginSession.toMs(row.last_seen_at) };
    }
    if (st && now - st.lastSeen > LoginSession.IDLE_MS) {
      LoginSession.close(st.id, formatTaipei(st.lastSeen), 'idle');
      state.delete(key);
      st = null;
    }
    if (!st) { open({ userId: req.user.id, sessionID: req.sessionID, ip: req.ip, userAgent: req.get('user-agent') }, null); return; }
    st.lastSeen = now;
    if (now - st.lastWrite >= WRITE_EVERY_MS) {
      LoginSession.touch(st.id, nowTaipei());
      st.lastWrite = now;
    }
  } catch (e) { /* 只是記錄用 */ }
}

// 主動登出
function end(sessionID, reason = 'logout') {
  try {
    const key = keyOf(sessionID);
    let st = state.get(key);
    const row = st ? { id: st.id } : LoginSession.findOpenByKey(key);
    if (row) LoginSession.close(row.id, nowTaipei(), reason);
    state.delete(key);
  } catch (e) { /* 只是記錄用 */ }
}

function middleware(req, res, next) {
  touch(req);
  next();
}

module.exports = { start, touch, end, middleware, keyOf, _state: state };
