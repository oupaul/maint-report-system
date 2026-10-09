// 巡檢批次與巡檢紀錄的 CSV 匯出（給 Excel 或其他工具分析、留存）：
// - batches：一個批次一列（標題、日期、狀態／簽核、涵蓋客戶、設備數、項目數、警告／異常數…）
// - records：一個「批次 × 設備 × 檢查項目」一列（含客戶、狀態、數值、備註、截圖數、記錄人；容量型項目另附最高使用率與磁碟區明細）
// 篩選條件兩種匯出共用（日期區間、客戶、批次範圍；紀錄明細另外可篩嚴重度與類別）。
// 儲存格開頭是 = + - @ 的文字由 utils/csv 補單引號防公式注入。
const db = require('../models/db');
const InspectionBatch = require('../models/InspectionBatch');
const InspectionVolume = require('../models/InspectionVolume');
const AssetCategory = require('../models/AssetCategory');
const ApprovalService = require('./ApprovalService');
const capacity = require('../utils/capacity');
const { toCsv } = require('../utils/csv');

const MAX_ROWS = 100000;
const STATUS_TEXT = { normal: '正常', warning: '警告', critical: '異常' };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z'));

function parseFilters(query) {
  const str = (v, max = 60) => String(v || '').slice(0, max);
  const num = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : 0; };
  return {
    from: isDate(str(query.from, 10)) ? str(query.from, 10) : '',
    to: isDate(str(query.to, 10)) ? str(query.to, 10) : '',
    customer: query.customer === 'none' ? 'none' : (/^\d{1,9}$/.test(str(query.customer, 12)) ? str(query.customer, 12) : ''),
    batch: num(query.batch),
    scope: query.scope === 'completed' ? 'completed' : '',                 // 只含已完成（或已核准）的批次
    severity: ['abnormal', 'warning', 'critical'].includes(query.severity) ? query.severity : '', // 只匯出警告／異常的項目
    category: str(query.category),
  };
}

function whereFor(f, { forRecords }) {
  const where = [];
  const params = [];
  if (f.from) { where.push('b.batch_date >= ?'); params.push(f.from); }
  if (f.to) { where.push('b.batch_date <= ?'); params.push(f.to); }
  if (f.batch) { where.push('b.id = ?'); params.push(f.batch); }
  if (f.scope === 'completed') where.push("b.status = 'completed'");
  if (f.customer) {
    // 紀錄明細：只要這個客戶的設備；批次清單：批次涵蓋這個客戶的任一台設備
    const cond = f.customer === 'none' ? 'x.customer_id IS NULL' : 'x.customer_id = ?';
    if (forRecords) { where.push(f.customer === 'none' ? 'a.customer_id IS NULL' : 'a.customer_id = ?'); if (f.customer !== 'none') params.push(Number(f.customer)); }
    else {
      where.push(`EXISTS (SELECT 1 FROM inspection_batch_assets ba JOIN assets x ON x.id = ba.asset_id WHERE ba.batch_id = b.id AND ${cond})`);
      if (f.customer !== 'none') params.push(Number(f.customer));
    }
  }
  if (forRecords) {
    if (f.severity === 'abnormal') where.push("ii.status IN ('warning','critical')");
    else if (f.severity) { where.push('ii.status = ?'); params.push(f.severity); }
    if (f.category) { where.push('a.category = ?'); params.push(f.category); }
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

function batchesCsv(f) {
  const w = whereFor(f, { forRecords: false });
  const rows = db.prepare(
    `SELECT b.*, u.display_name AS cn, u.username AS cu FROM inspection_batches b LEFT JOIN users u ON u.id = b.created_by ${w.sql}
     ORDER BY b.batch_date DESC, b.id DESC`
  ).all(...w.params);
  if (rows.length > MAX_ROWS) throw Object.assign(new Error('資料太多，請縮小日期範圍或條件'), { userFacing: true });
  const cust = InspectionBatch.customerSummary();
  const counts = new Map(db.prepare(
    `SELECT batch_id, COUNT(*) AS n, SUM(status = 'warning') AS w, SUM(status = 'critical') AS c FROM inspection_items GROUP BY batch_id`
  ).all().map(r => [r.batch_id, r]));
  const header = ['批次編號', '標題', '巡檢日期', '狀態', '涵蓋客戶', '設備數', '未指定客戶設備數', '檢查項目數', '警告項目數', '異常項目數', '建立者', '建立時間', '完成時間', '備註'];
  const lines = [header, ...rows.map(b => {
    const c = cust.get(b.id) || { customers: [], unassigned: 0, total: 0 };
    const n = counts.get(b.id) || { n: 0, w: 0, c: 0 };
    return [
      b.id, b.title, b.batch_date, ApprovalService.statusInfo(b).text, c.customers.map(x => x.name).join('、'), c.total, c.unassigned,
      n.n, n.w || 0, n.c || 0, b.cn || b.cu || '', b.created_at || '', b.completed_at || '', b.notes || '',
    ];
  })];
  return { csv: toCsv(lines), count: rows.length };
}

function recordsCsv(f) {
  const w = whereFor(f, { forRecords: true });
  const rows = db.prepare(
    `SELECT ii.id, ii.batch_id, ii.asset_id, ii.status, ii.value_text, ii.note, ii.recorded_at, ii.source,
            COALESCE(ii.item_label, ci.label) AS item_label,
            b.title AS batch_title, b.batch_date, b.status AS batch_status, b.approval_status,
            a.name AS asset_name, a.category, a.location, a.ip_address, a.serial_number, a.asset_tag,
            cu.name AS customer_name, ru.display_name AS rn, ru.username AS ru,
            (SELECT COUNT(*) FROM inspection_item_photos p WHERE p.inspection_item_id = ii.id) AS photo_count
     FROM inspection_items ii
     JOIN inspection_batches b ON b.id = ii.batch_id
     JOIN assets a ON a.id = ii.asset_id
     JOIN checklist_items ci ON ci.id = ii.checklist_item_id
     LEFT JOIN customers cu ON cu.id = a.customer_id
     LEFT JOIN users ru ON ru.id = ii.recorded_by
     ${w.sql}
     ORDER BY b.batch_date DESC, b.id DESC, (cu.name IS NULL) ASC, cu.name COLLATE NOCASE ASC, a.name ASC, ci.sort_order ASC
     LIMIT ${MAX_ROWS + 1}`
  ).all(...w.params);
  if (rows.length > MAX_ROWS) throw Object.assign(new Error(`資料超過 ${MAX_ROWS} 筆，請縮小日期範圍或條件`), { userFacing: true });
  InspectionVolume.attach(rows);
  const labels = AssetCategory.labelMap();
  const header = ['批次編號', '批次標題', '巡檢日期', '批次狀態', '客戶', '資產ID', '設備名稱', '類別', '位置', 'IP位址', '序號', '財產編號',
    '檢查項目', '狀態', '數值', '最高使用率(%)', '磁碟區明細', '備註', '截圖數', '記錄人', '記錄時間'];
  const lines = [header, ...rows.map(r => {
    const maxPct = r.volumes.length ? Math.round(Math.max(...r.volumes.map(capacity.pct)) * 10) / 10 : '';
    return [
      r.batch_id, r.batch_title, r.batch_date, ApprovalService.statusInfo({ status: r.batch_status, approval_status: r.approval_status, id: r.batch_id }).text,
      r.customer_name || '', r.asset_id, r.asset_name, labels[r.category] || r.category, r.location || '', r.ip_address || '', r.serial_number || '', r.asset_tag || '',
      r.item_label, STATUS_TEXT[r.status] || r.status, r.value_text || '', maxPct,
      r.volumes.map(v => `${v.name} 已用 ${capacity.fmtGb(v.used_gb)} / 總容量 ${capacity.fmtGb(v.total_gb)} GB（${capacity.fmtPct(capacity.pct(v))}）`).join('；'),
      r.note || '', r.photo_count, r.rn || r.ru || '', r.recorded_at || '',
    ];
  })];
  return { csv: toCsv(lines), count: rows.length };
}

module.exports = { parseFilters, batchesCsv, recordsCsv, MAX_ROWS };
