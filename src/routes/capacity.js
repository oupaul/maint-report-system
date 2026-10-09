const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const Asset = require('../models/Asset');
const InspectionVolume = require('../models/InspectionVolume');
const capacity = require('../utils/capacity');
const { renderTrendSvg } = require('../utils/trendChart');

const ATTENTION_DAYS = 180; // 預估 6 個月內會達 90% 的算「需要注意」

// 一條趨勢序列要不要列入「需要注意」：目前使用率已達警告門檻，或預估很快會達 90%（或已經超過）
function needsAttention(s) {
  if (s.last.pct >= s.warn_pct) return true;
  const f = s.forecast;
  return !!(f && f.ok && (f.reached || (f.daysToTarget != null && f.daysToTarget <= ATTENTION_DAYS)));
}

// 排序：已達異常門檻 → 預估最快達標 → 使用率高的在前；沒有預測的排最後
function attentionRank(s) {
  const f = s.forecast;
  const days = f && f.ok ? (f.reached ? -1 : (f.daysToTarget != null ? f.daysToTarget : Infinity)) : Infinity;
  return [s.last.pct >= s.crit_pct ? 0 : 1, days, -s.last.pct];
}
function compareRank(a, b) {
  const ra = attentionRank(a);
  const rb = attentionRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] < rb[i] ? -1 : 1;
  }
  return 0;
}

// 預測的文字說明（趨勢頁、容量預警頁共用）
function forecastText(s) {
  const f = s.forecast;
  if (!f || !f.ok) {
    if (f && f.reason === 'few') return `資料還不夠預測（需要至少 3 次、時間跨度 28 天以上的記錄；目前 ${f.n} 次、跨 ${f.spanDays} 天）`;
    return '尚無資料';
  }
  if (f.reached) return '已達 90% 以上';
  if (f.flat) return `使用量沒有上升趨勢（依最近 ${f.n} 次記錄）`;
  const gb = capacity.fmtGb(f.perMonthGb);
  const when = f.dateTarget ? `${capacity.humanDuration(f.daysToTarget)}後（約 ${f.dateTarget}）達 90%` : '短期內不會達到 90%';
  const full = f.dateFull ? `，約 ${f.dateFull} 滿` : '';
  return `每月約增加 ${gb} GB；預估${when}${full}（依最近 ${f.n} 次、${f.spanDays} 天的記錄）`;
}

function allSeries() {
  return InspectionVolume.buildSeries(InspectionVolume.allRows()).filter(s => s.is_active);
}

router.get('/', requireLogin, (req, res) => {
  const all = allSeries().sort(compareRank);
  const showAll = req.query.view === 'all';
  const list = showAll ? all : all.filter(needsAttention);
  const per = 100;
  const pages = Math.max(1, Math.ceil(list.length / per));
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  res.render('capacity/overview', {
    rows: list.slice((page - 1) * per, page * per).map(s => ({ ...s, text: forecastText(s) })),
    total: all.length,
    attentionCount: all.filter(needsAttention).length,
    showAll, page, pages, fmt: capacity,
  });
});

router.get('/assets/:id', requireLogin, (req, res) => {
  const asset = Asset.findById(parseInt(req.params.id, 10));
  if (!asset) return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  const series = InspectionVolume.buildSeries(
    InspectionVolume.seriesForAsset(asset.id).map(r => ({ ...r, asset_id: asset.id, asset_name: asset.name, volume: r.name }))
  ).map(s => ({ ...s, svg: renderTrendSvg(s), text: forecastText(s) }));
  res.render('capacity/trend', { asset, series, fmt: capacity });
});

// 匯出每次巡檢、每個磁碟區一列的 CSV（給 Excel 或其他工具分析）。加 BOM 讓 Excel 正確辨識 UTF-8；
// 開頭是 = + - @ 的儲存格前面補一個單引號，避免被當成公式執行（CSV injection）。
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
router.get('/export.csv', requireLogin, (req, res) => {
  const header = ['設備', '位置', '檢查項目', '巡檢批次', '巡檢日期', '磁碟區', '已用(GB)', '剩餘(GB)', '總容量(GB)', '使用率(%)'];
  const lines = [header.map(cell).join(',')];
  for (const r of InspectionVolume.allRows()) {
    lines.push([
      r.asset_name, r.location || '', r.item_label, r.batch_title, r.date, r.volume,
      r.used_gb, Math.round((r.total_gb - r.used_gb) * 1000) / 1000, r.total_gb, Math.round(capacity.pct(r) * 10) / 10,
    ].map(cell).join(','));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="capacity-history.csv"',
  });
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

module.exports = router;
module.exports.allAttention = () => allSeries().filter(needsAttention).sort(compareRank).map(s => ({ ...s, text: forecastText(s) }));
