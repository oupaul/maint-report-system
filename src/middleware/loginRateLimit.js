// 登入失敗限流（純記憶體，單一 process 夠用，服務重啟會清空）：
// - 同一個 IP 15 分鐘內失敗超過 20 次 → 暫時擋掉這個 IP（防止拿一批帳號亂試）
// - 同一個「帳號＋IP」15 分鐘內失敗超過 5 次 → 暫時擋掉這個組合（防止猜單一帳號的密碼）
// 帳號限制綁 IP 而不是只看帳號名稱，避免有人故意拿別人的帳號名稱亂打，就把本人也鎖在外面。
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { ip: 20, userIp: 5 };

const buckets = new Map(); // key -> { count, resetAt }

function bump(key) {
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function isBlocked(key, limit) {
  const entry = buckets.get(key);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    buckets.delete(key);
    return false;
  }
  return entry.count >= limit;
}

function keys(req, username) {
  const ip = req.ip || 'unknown';
  return {
    ipKey: `ip:${ip}`,
    userKey: `user:${String(username || '').toLowerCase()}@${ip}`,
  };
}

const LoginRateLimit = {
  isBlocked(req, username) {
    const { ipKey, userKey } = keys(req, username);
    return isBlocked(ipKey, LIMITS.ip) || isBlocked(userKey, LIMITS.userIp);
  },
  recordFailure(req, username) {
    const { ipKey, userKey } = keys(req, username);
    bump(ipKey);
    bump(userKey);
  },
  recordSuccess(req, username) {
    const { userKey } = keys(req, username);
    buckets.delete(userKey);
  },
};

// 定期清掉過期的紀錄，避免 Map 無限長大；unref() 讓它不會擋住 process 結束
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = LoginRateLimit;
