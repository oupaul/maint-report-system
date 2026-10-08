// 「目前誰在線上」：只放記憶體、不寫資料庫（跟 expense-platform 的 activityTracker 同樣的取捨）。
// 這裡要的只是「最近幾分鐘內還有沒有人在操作」的即時資訊，不是可稽核的登入紀錄，
// 沒必要讓每個請求多一次資料庫寫入；服務重啟會清空，使用者下一次操作就會重新出現。
// 以 session 為單位記錄（同一個人在兩台裝置登入會是兩列），所以看得出是哪個 IP／哪台裝置。
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

const sessions = new Map(); // sessionID -> entry

// 不引入 UA 解析套件，只做畫面上「看得出是什麼裝置」所需的粗略判斷
function describeAgent(ua) {
  if (!ua) return '未知裝置';
  let os = '其他系統';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux|X11/.test(ua)) os = 'Linux';

  let browser = '其他瀏覽器';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `${browser} / ${os}`;
}

function track(req) {
  if (!req.user || !req.sessionID) return;
  const now = Date.now();
  const prev = sessions.get(req.sessionID);
  sessions.set(req.sessionID, {
    userId: req.user.id,
    username: req.user.username,
    displayName: req.user.display_name || null,
    role: req.user.role,
    ip: req.ip || '未知',
    agent: describeAgent(req.get('user-agent')),
    firstSeen: prev ? prev.firstSeen : now,
    lastSeen: now,
    // 只記路徑、不記查詢字串（網址上可能帶 CSRF token 之類的東西）
    lastPath: req.method === 'GET' ? req.path : (prev ? prev.lastPath : req.path),
  });
}

function remove(sessionID) {
  sessions.delete(sessionID);
}

function prune(now = Date.now()) {
  for (const [sid, entry] of sessions) {
    if (now - entry.lastSeen > FORGET_AFTER_MS) sessions.delete(sid);
  }
}

function listOnline(now = Date.now()) {
  prune(now);
  return Array.from(sessions.values())
    .filter((e) => now - e.lastSeen <= ONLINE_WINDOW_MS)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function middleware(req, res, next) {
  track(req);
  next();
}

module.exports = { track, remove, listOnline, middleware, describeAgent, ONLINE_WINDOW_MS };
