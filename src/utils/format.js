// 管理員頁面（系統狀態、備份管理）共用的顯示格式化
const { formatTaipei } = require('./time');

function bytes(n) {
  if (n === null || n === undefined) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小時`;
  if (h > 0) return `${h} 小時 ${m} 分`;
  if (m > 0) return `${m} 分鐘`;
  return `${s} 秒`;
}

function ago(ms, now = Date.now()) {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 10) return '剛剛';
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

const STATUS_LABEL = { ok: '正常', warn: '注意', bad: '異常' };
const STATUS_CLASS = { ok: 'normal', warn: 'warning', bad: 'critical' };

module.exports = { bytes, duration, ago, time: formatTaipei, STATUS_LABEL, STATUS_CLASS };
