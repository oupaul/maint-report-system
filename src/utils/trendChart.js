// 容量趨勢圖：伺服器端直接產生 SVG 字串（不需要前端套件，也不需要 inline script，CSP 友善）。
// 橫軸是日期、縱軸是使用率 0–100%，虛線是警告／異常門檻；有預測時用淡色虛線從最後一點延伸出去。
const capacity = require('./capacity');

const W = 760;
const H = 260;
const M = { l: 44, r: 16, t: 14, b: 34 };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayOf = (date) => Date.parse(date + 'T00:00:00Z') / 86400000;
const dateOf = (day) => new Date(day * 86400000).toISOString().slice(0, 10);

function renderTrendSvg(series) {
  const pts = series.points;
  const d0 = dayOf(pts[0].date);
  const dLast = dayOf(pts[pts.length - 1].date);
  const f = series.forecast;
  // 預測線畫到「預估滿」或最多再延伸一段時間（歷史跨度的一半，至少 90 天、最多 365 天）
  let proj = null;
  if (f && f.ok && !f.reached && !f.flat && f.slope > 0) {
    const last = series.last;
    const ext = Math.min(Math.max((dLast - d0) * 0.5, 90), 365);
    const dEnd = Math.min(dLast + ext, dLast + f.daysToFull);
    const usedEnd = Math.min(last.total_gb, last.used_gb + f.slope * (dEnd - dLast));
    proj = { dEnd, pctEnd: (usedEnd / last.total_gb) * 100 };
  }
  const dMax = Math.max(dLast, proj ? proj.dEnd : dLast);
  const span = Math.max(dMax - d0, 1);
  const x = (day) => M.l + ((day - d0) / span) * (W - M.l - M.r);
  const y = (p) => M.t + (1 - Math.min(Math.max(p, 0), 100) / 100) * (H - M.t - M.b);

  const parts = [];
  parts.push(`<svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.volume)} 使用率趨勢" xmlns="http://www.w3.org/2000/svg">`);
  for (const g of [0, 25, 50, 75, 100]) {
    parts.push(`<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${y(g)}" y2="${y(g)}"/><text x="${M.l - 6}" y="${y(g) + 4}" text-anchor="end">${g}%</text>`);
  }
  parts.push(`<line class="th-warn" x1="${M.l}" x2="${W - M.r}" y1="${y(series.warn_pct)}" y2="${y(series.warn_pct)}"/>`);
  parts.push(`<line class="th-crit" x1="${M.l}" x2="${W - M.r}" y1="${y(series.crit_pct)}" y2="${y(series.crit_pct)}"/>`);
  if (proj) {
    parts.push(`<line class="proj" x1="${x(dLast)}" y1="${y(series.last.pct)}" x2="${x(proj.dEnd)}" y2="${y(proj.pctEnd)}"/>`);
  }
  if (pts.length > 1) {
    parts.push(`<polyline class="line" points="${pts.map(p => `${x(dayOf(p.date)).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')}"/>`);
  }
  for (const p of pts) {
    parts.push(`<circle class="dot" cx="${x(dayOf(p.date)).toFixed(1)}" cy="${y(p.pct).toFixed(1)}" r="3.5"><title>${esc(p.date)}：${esc(capacity.fmtGb(p.used_gb))} / ${esc(capacity.fmtGb(p.total_gb))} GB（${esc(capacity.fmtPct(p.pct))}）</title></circle>`);
  }
  parts.push(`<text x="${M.l}" y="${H - 10}">${esc(pts[0].date)}</text>`);
  if (dMax > d0) parts.push(`<text x="${W - M.r}" y="${H - 10}" text-anchor="end">${esc(dateOf(dMax))}${proj ? '（預測）' : ''}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

module.exports = { renderTrendSvg };
