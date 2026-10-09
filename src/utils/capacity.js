// 容量型檢查項目（磁碟空間）的計算：輸入解析、名稱整理、使用率、狀態建議、趨勢預測。容量一律用 GB。
const MAX_GB = 10_000_000;
const MAX_VOLUMES = 20;
const MAX_NAME = 20;
const UNIT_TO_GB = { M: 1 / 1024, MB: 1 / 1024, G: 1, GB: 1, T: 1024, TB: 1024 };

// 解析容量輸入：數字，可帶單位（MB/GB/TB，不分大小寫，預設 GB），千分位逗號可有可無。回傳 GB 或 null（無法解析）
function parseSize(input) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(MB|GB|TB|M|G|T)?\s*$/i.exec(String(input == null ? '' : input).replace(/,/g, ''));
  if (!m) return null;
  const gb = Number(m[1]) * (m[2] ? UNIT_TO_GB[m[2].toUpperCase()] : 1);
  if (!Number.isFinite(gb) || gb > MAX_GB) return null;
  return Math.round(gb * 1000) / 1000;
}

// 磁碟區名稱：「c」「C」「c:」統一成「C:」，避免同一顆碟被當成三條趨勢線；其他名稱（Volume1、資料碟）照原樣
function normalizeVolumeName(input) {
  const t = String(input == null ? '' : input).replace(/\s+/g, ' ').trim();
  if (/^[a-z]:?\\?$/i.test(t)) return t[0].toUpperCase() + ':';
  return t;
}

const asArray = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v]));

// 解析表單的磁碟區列（欄位 vol_name / vol_used / vol_free / vol_total，同名重複送出就是多列）。
// vol_total 是「上次記錄的總容量」提示：只填已用、沒填剩餘時，用它推算剩餘（總容量 − 已用）。
// 名稱、已用、剩餘全空的列直接略過（預先帶入但沒填的列）。回傳 { volumes, error }
function parseVolumes(body) {
  const names = asArray(body.vol_name);
  const used = asArray(body.vol_used);
  const free = asArray(body.vol_free);
  const totals = asArray(body.vol_total);
  const volumes = [];
  const seen = new Set();
  for (let i = 0; i < Math.max(names.length, used.length, free.length); i++) {
    const rawName = String(names[i] == null ? '' : names[i]);
    const rawUsed = String(used[i] == null ? '' : used[i]).trim();
    const rawFree = String(free[i] == null ? '' : free[i]).trim();
    if (!rawName.trim() && !rawUsed && !rawFree) continue;
    if (!rawUsed && !rawFree) continue; // 只有名稱（預先帶入、還沒填數字）：略過
    const name = normalizeVolumeName(rawName);
    if (!name) return { volumes, error: '請輸入磁碟區名稱（例如 C:）' };
    if (name.length > MAX_NAME) return { volumes, error: `磁碟區名稱「${name.slice(0, 8)}…」太長了（最多 ${MAX_NAME} 個字）` };
    if (/[\u0000-\u001f<>]/.test(name)) return { volumes, error: `磁碟區名稱「${name}」含有不允許的字元` };
    if (seen.has(name.toLowerCase())) return { volumes, error: `磁碟區「${name}」重複了` };
    seen.add(name.toLowerCase());
    const usedGb = parseSize(rawUsed);
    if (!rawUsed || usedGb == null) return { volumes, error: `磁碟區「${name}」的已用容量請輸入數字（可加單位，例如 55.2 或 1.2TB）` };
    let totalGb;
    if (rawFree) {
      const freeGb = parseSize(rawFree);
      if (freeGb == null) return { volumes, error: `磁碟區「${name}」的剩餘容量請輸入數字（可加單位，例如 243 或 1.2TB）` };
      totalGb = usedGb + freeGb;
    } else {
      const hint = parseSize(totals[i]);
      if (hint == null || usedGb > hint) return { volumes, error: `磁碟區「${name}」請填剩餘容量（沒有上次的總容量可以推算）` };
      totalGb = hint;
    }
    totalGb = Math.round(totalGb * 1000) / 1000;
    if (totalGb <= 0) return { volumes, error: `磁碟區「${name}」的總容量必須大於 0` };
    volumes.push({ name, used_gb: usedGb, total_gb: totalGb });
    if (volumes.length > MAX_VOLUMES) return { volumes, error: `一個項目最多 ${MAX_VOLUMES} 個磁碟區` };
  }
  return { volumes, error: null };
}

const pct = (v) => (v.total_gb > 0 ? (v.used_gb / v.total_gb) * 100 : 0);
const fmtPct = (p) => `${(Math.round(p * 10) / 10).toFixed(1)}%`;
const fmtGb = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// 存進 value_text 的摘要（搜尋、舊畫面相容用）：C: 55.2 / 298.2 GB（18.5%）；D: …
function summaryText(volumes) {
  return volumes.map(v => `${v.name} ${fmtGb(v.used_gb)} / ${fmtGb(v.total_gb)} GB（${fmtPct(pct(v))}）`).join('；');
}

// 給 PDF／摘要頁用的一行一個磁碟區
function volumeLines(volumes) {
  return volumes.map(v => `${v.name}　已用 ${fmtGb(v.used_gb)} GB ／ 總容量 ${fmtGb(v.total_gb)} GB（使用率 ${fmtPct(pct(v))}）`);
}

// 依最高使用率建議狀態
function suggestStatus(volumes, warnPct, critPct) {
  if (!volumes || volumes.length === 0) return null;
  const warn = warnPct || 85;
  const crit = critPct || 95;
  const max = Math.max(...volumes.map(pct));
  return { max, status: max >= crit ? 'critical' : (max >= warn ? 'warning' : 'normal') };
}

// 趨勢預測：points = [{ date: 'YYYY-MM-DD', used_gb, total_gb }]（同一台設備同一個磁碟區、依日期排序）。
// 只用「最近一次擴充容量之後」（總容量和最新一筆相同）的點做線性回歸——擴充後使用率會往下掉，混進去會讓預測失準。
// 至少 3 個點、時間跨度至少 28 天才預測，否則回傳 { ok: false, reason }，避免資料太少亂預測。
function forecast(points, { targetPct = 90 } = {}) {
  if (!points || points.length === 0) return { ok: false, reason: 'nodata' };
  const last = points[points.length - 1];
  const same = [];
  for (let i = points.length - 1; i >= 0; i--) {
    if (Math.abs(points[i].total_gb - last.total_gb) > last.total_gb * 0.005) break;
    same.unshift(points[i]);
  }
  const day = (p) => Date.parse(p.date + 'T00:00:00Z') / 86400000;
  const span = day(same[same.length - 1]) - day(same[0]);
  if (same.length < 3 || span < 28) return { ok: false, reason: 'few', n: same.length, spanDays: Math.round(span) };
  const xs = same.map(p => day(p) - day(same[0]));
  const ys = same.map(p => p.used_gb);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  const slope = den > 0 ? num / den : 0; // GB / 天
  const target = (targetPct / 100) * last.total_gb;
  if (last.used_gb >= target) return { ok: true, reached: true, slope, n, spanDays: Math.round(span), perMonthGb: slope * 30 };
  if (slope <= 0.0001) return { ok: true, flat: true, slope, n, spanDays: Math.round(span), perMonthGb: slope * 30 };
  const daysToTarget = (target - last.used_gb) / slope;
  const daysToFull = (last.total_gb - last.used_gb) / slope;
  const at = (d) => new Date(day(last) * 86400000 + d * 86400000).toISOString().slice(0, 10);
  return {
    ok: true, slope, perMonthGb: slope * 30, n, spanDays: Math.round(span),
    daysToTarget, dateTarget: daysToTarget <= 365 * 20 ? at(daysToTarget) : null,
    daysToFull, dateFull: daysToFull <= 365 * 20 ? at(daysToFull) : null,
  };
}

// 盡力解析舊的純文字記錄（改成容量型之前填的），例如「C已用55.2GB剩餘243GB D已用736GB剩餘826GB」。
// 支援「名稱 已用 X 剩餘 Y」與「名稱 剩餘 Y 已用 X」，數字可帶 MB/GB/TB（沒寫單位當 GB）。
// 只有「整段文字都能被解析、沒有多餘內容」才算成功，否則回傳 null——寧可不解析也不要猜錯。
const NUM = '(\\d+(?:\\.\\d+)?)\\s*(TB|GB|MB|T|G|M)?';
const NAME = '([A-Za-z]:?|[\\u4e00-\\u9fffA-Za-z0-9_\\-]{1,12}?)';
function legacyRegex(first, second) {
  return new RegExp(`${NAME}\\s*[:：]?\\s*${first}\\s*${NUM}\\s*${second}\\s*${NUM}`, 'gi');
}
function parseLegacyText(text) {
  const s = String(text || '').replace(/[，、;；]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const [first, second, usedFirst] of [['已用', '剩餘', true], ['剩餘', '已用', false]]) {
    const re = legacyRegex(first, second);
    const volumes = [];
    let m;
    let rest = s;
    const seen = new Set();
    let bad = false;
    while ((m = re.exec(s)) !== null) {
      const name = normalizeVolumeName(m[1]);
      const a = parseSize(m[2] + (m[3] || ''));
      const b = parseSize(m[4] + (m[5] || ''));
      if (!name || a == null || b == null || seen.has(name.toLowerCase())) { bad = true; break; }
      seen.add(name.toLowerCase());
      const used = usedFirst ? a : b;
      const free = usedFirst ? b : a;
      const total = Math.round((used + free) * 1000) / 1000;
      if (total <= 0) { bad = true; break; }
      volumes.push({ name, used_gb: used, total_gb: total });
      rest = rest.replace(m[0], '');
    }
    if (!bad && volumes.length > 0 && volumes.length <= MAX_VOLUMES && rest.replace(/[\s:：/、,.]/g, '') === '') return volumes;
  }
  return null;
}

function humanDuration(days) {
  if (days < 45) return `約 ${Math.max(1, Math.round(days))} 天`;
  if (days < 365 * 2) return `約 ${Math.round(days / 30)} 個月`;
  return `約 ${(days / 365).toFixed(1)} 年`;
}

module.exports = {
  MAX_VOLUMES, parseSize, normalizeVolumeName, parseVolumes, pct, fmtPct, fmtGb,
  summaryText, volumeLines, suggestStatus, forecast, humanDuration, parseLegacyText,
};
