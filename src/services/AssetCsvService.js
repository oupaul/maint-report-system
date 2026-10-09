// 資產 CSV 匯出／匯入。
// - 匯出：固定欄位＋啟用中的自訂欄位，欄位順序與表頭固定，匯出的檔案可以直接改完再匯入（含「資產ID」）。
// - 匯入：兩步驟。先「規劃」（plan，只讀）產生每一列的處理結果與差異給使用者預覽，確認後才「套用」（apply，單一交易）。
//   套用時用保存的原始資料重新規劃一次（預覽之後資料庫可能又變了），錯誤的列一律略過，只寫有效的列。
// 規則：
//   · 有「資產ID」的列＝更新該資產；沒有＝新增。同名同類別的設備已存在時，新增那一列視為錯誤（避免重複匯入產生一堆重複設備）。
//   · 欄位（欄）存在但儲存格空白＝清空該欄；整個欄位（欄）不在檔案裡＝完全不動。預覽會明確列出每一個「清空」。
//   · IP／MAC 格式與重複只警告、不擋；日期、數字、下拉選項、類別等明確錯誤才擋。
const crypto = require('crypto');
const db = require('../models/db');
const Asset = require('../models/Asset');
const AssetCategory = require('../models/AssetCategory');
const AssetField = require('../models/AssetField');
const AssetTag = require('../models/AssetTag');
const assetFields = require('../utils/assetFields');
const csv = require('../utils/csv');

const MAX_ROWS = 5000;
const MAX_NAME = 100;
const MAX_NOTES = 2000;
const PENDING_TTL_MS = 30 * 60 * 1000;

// 固定欄位（順序就是匯出的順序）。aliases 讓人用英文或舊的寫法也能對應
const FIXED = [
  { key: 'id', label: '資產ID', aliases: ['id', 'asset_id', 'assetid'] },
  { key: 'name', label: '資產名稱', aliases: ['名稱', 'name', 'assetname'] },
  { key: 'category', label: '類別', aliases: ['類型', 'category', 'type'] },
  { key: 'location', label: '位置', aliases: ['location'] },
  { key: 'tags', label: '標籤', aliases: ['tags', 'tag'] },
  { key: 'ip_address', label: 'IP位址', aliases: ['ip', 'ip_address', 'ipaddress'] },
  { key: 'mac_address', label: 'MAC位址', aliases: ['mac', 'mac_address', 'macaddress'] },
  { key: 'hostname', label: '主機名稱', aliases: ['hostname', 'host'] },
  { key: 'serial_number', label: '序號', aliases: ['serial', 'serial_number', 'sn'] },
  { key: 'asset_tag', label: '財產編號', aliases: ['asset_tag', 'assettag'] },
  { key: 'brand', label: '廠牌', aliases: ['brand'] },
  { key: 'model', label: '型號', aliases: ['model'] },
  { key: 'purchase_date', label: '購置日期', aliases: ['purchase_date', 'purchasedate'] },
  { key: 'notes', label: '備註', aliases: ['notes', 'note'] },
  { key: 'status', label: '狀態', aliases: ['status', 'is_active'] },
];
const STATUS_ON = ['啟用', '啟用中', '1', 'true', 'yes', 'y', '是', 'active', 'on'];
const STATUS_OFF = ['停用', '已停用', '0', 'false', 'no', 'n', '否', 'inactive', 'off'];
const BOOL_ON = ['是', '1', 'true', 'yes', 'y'];
const BOOL_OFF = ['否', '0', 'false', 'no', 'n'];

const norm = (s) => String(s == null ? '' : s).replace(/^﻿/, '').replace(/\s+/g, '').toLowerCase();
const cleanLocation = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 100);

// Excel 常把 2024-03-15 改存成 2024/3/15：統一轉成 YYYY-MM-DD 再交給驗證
function normalizeDate(v) {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(v);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : v;
}

// ---------- 匯出 ----------

function headerRow() {
  return [...FIXED.map(f => f.label), ...AssetField.findAll({ activeOnly: true }).map(d => d.label)];
}

function exportCsv(assets) {
  const defs = AssetField.findAll({ activeOnly: true });
  const labels = AssetCategory.labelMap();
  const rows = [headerRow()];
  for (const a of assets) {
    rows.push([
      a.id, a.name, labels[a.category] || a.category, a.location || '', (a.tags || []).join(', '),
      a.ip_address || '', a.mac_address || '', a.hostname || '', a.serial_number || '', a.asset_tag || '',
      a.brand || '', a.model || '', a.purchase_date || '', a.notes || '', a.is_active ? '啟用' : '停用',
      ...defs.map(d => {
        const v = a.custom && a.custom[d.id];
        // 這台設備的類別不適用這個欄位時留空
        return AssetField.appliesTo(d, a.category) ? AssetField.formatValue(d, v) : '';
      }),
    ]);
  }
  return csv.toCsv(rows);
}

function templateCsv() {
  return csv.toCsv([headerRow()]);
}

// ---------- 規劃（預覽） ----------

function mapColumns(headerCells) {
  const defs = AssetField.findAll({ activeOnly: true });
  const fixedByName = new Map();
  FIXED.forEach(f => [f.label, ...f.aliases].forEach(n => fixedByName.set(norm(n), f)));
  const customByName = new Map(defs.map(d => [norm(d.label), d]));
  const cols = [];
  const ignored = [];
  const errors = [];
  const seen = new Set();
  headerCells.forEach((raw, index) => {
    const name = norm(raw);
    if (!name) return;
    let col = null;
    if (fixedByName.has(name)) col = { index, kind: 'fixed', key: fixedByName.get(name).key, label: fixedByName.get(name).label };
    else if (customByName.has(name)) col = { index, kind: 'custom', def: customByName.get(name), label: customByName.get(name).label };
    if (!col) { ignored.push(String(raw).trim()); return; }
    const id = col.kind === 'fixed' ? col.key : `cf_${col.def.id}`;
    if (seen.has(id)) { errors.push(`欄位「${col.label}」重複出現了`); return; }
    seen.add(id);
    cols.push(col);
  });
  if (!cols.some(c => c.kind === 'fixed' && (c.key === 'name' || c.key === 'id'))) {
    errors.push('找不到「資產名稱」或「資產ID」欄位，請確認第一列是表頭（建議從「下載匯入範本」開始）');
  }
  return { cols, ignored, errors };
}

function displayCustom(def, v) { return AssetField.formatValue(def, v); }

function plan(table) {
  const result = { fileErrors: [], ignoredColumns: [], rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0, warnings: 0, clears: 0 } };
  if (!table || table.length < 2) { result.fileErrors.push('檔案裡沒有資料列（第一列要是表頭）'); return result; }
  const { cols, ignored, errors } = mapColumns(table[0]);
  result.ignoredColumns = ignored;
  if (errors.length) { result.fileErrors.push(...errors); return result; }
  const dataRows = table.slice(1).map((cells, i) => ({ cells, line: i + 2 })).filter(r => r.cells.some(c => String(c).trim() !== ''));
  if (dataRows.length === 0) { result.fileErrors.push('檔案裡沒有資料列'); return result; }
  if (dataRows.length > MAX_ROWS) { result.fileErrors.push(`一次最多匯入 ${MAX_ROWS} 筆（這個檔案有 ${dataRows.length} 筆），請分批匯入`); return result; }

  const colByKey = new Map(cols.filter(c => c.kind === 'fixed').map(c => [c.key, c]));
  const customCols = cols.filter(c => c.kind === 'custom');
  const categories = AssetCategory.findAll();
  const catByName = new Map();
  categories.forEach(c => { catByName.set(norm(c.label), c); catByName.set(norm(c.code), c); });
  const allAssets = Asset.findAll({ includeInactive: true });
  const byId = new Map(allAssets.map(a => [a.id, a]));
  const nameKey = (name, category) => `${String(name).toLowerCase()}|${category}`;
  const existingNames = new Map(allAssets.map(a => [nameKey(a.name, a.category), a.id]));
  const valuesByAsset = new Map();
  db.prepare('SELECT asset_id, field_id, value FROM asset_field_values').all().forEach(r => {
    if (!valuesByAsset.has(r.asset_id)) valuesByAsset.set(r.asset_id, {});
    valuesByAsset.get(r.asset_id)[r.field_id] = r.value;
  });
  const dupIndex = assetFields.buildDuplicateIndex(allAssets);
  const seenNames = new Set();
  const labels = AssetCategory.labelMap();

  for (const { cells, line } of dataRows) {
    const cell = (key) => {
      const c = colByKey.get(key);
      return c ? csv.stripFormulaGuard(String(cells[c.index] == null ? '' : cells[c.index])).trim() : undefined;
    };
    const row = { line, action: 'error', errors: [], warnings: [], changes: [], name: cell('name') || '', id: null, apply: null };
    result.rows.push(row);
    const fail = (msg) => { row.errors.push(msg); };

    // 資產ID：有填＝更新，沒填＝新增
    let current = null;
    const rawId = cell('id');
    if (rawId) {
      if (!/^\d+$/.test(rawId)) fail(`資產ID「${rawId}」不是數字`);
      else {
        current = byId.get(Number(rawId)) || null;
        if (!current) fail(`找不到資產ID ${rawId}`);
        else row.id = current.id;
      }
    }
    if (row.errors.length) continue;
    const mode = current ? 'update' : 'create';

    // 名稱
    const nameCell = cell('name');
    const name = nameCell !== undefined ? nameCell : (current ? current.name : '');
    if (!name) fail('資產名稱不能空白');
    else if (name.length > MAX_NAME) fail(`資產名稱太長了（最多 ${MAX_NAME} 個字）`);
    row.name = name || row.name;

    // 類別
    let category = current ? current.category : null;
    const catCell = cell('category');
    if (catCell) {
      const found = catByName.get(norm(catCell));
      if (!found) fail(`找不到類別「${catCell}」（請用系統裡的類別名稱：${categories.filter(c => c.is_active).map(c => c.label).join('、')}）`);
      else if (!current || found.code !== current.category) {
        if (!found.is_active) fail(`類別「${found.label}」已停用`);
        else if (current && Asset.hasRecords(current.id)) fail('這個設備已經有檢查紀錄，不能變更類別');
        else category = found.code;
      }
    }
    if (!category && !row.errors.length) fail('新增設備必須填「類別」');

    // 固定文字欄位（IP／MAC／主機名稱…）：欄位不在檔案裡＝沿用目前的值；在檔案裡＝以儲存格為準（空白＝清空）
    const body = {};
    for (const key of ['ip_address', 'mac_address', 'hostname', 'serial_number', 'asset_tag', 'brand', 'model', 'purchase_date']) {
      const v = cell(key);
      body[key] = v !== undefined ? (key === 'purchase_date' ? normalizeDate(v) : v) : (current ? (current[key] || '') : '');
    }
    const fields = assetFields.normalize(body);
    if (fields.error) fail(fields.error);

    const location = cell('location') !== undefined ? cleanLocation(cell('location')) : (current ? (current.location || '') : '');
    const notesCell = cell('notes');
    const notes = notesCell !== undefined ? notesCell : (current ? (current.notes || '') : '');
    if (notes.length > MAX_NOTES) fail(`備註太長了（最多 ${MAX_NOTES} 個字）`);

    // 標籤
    let tags;
    if (cell('tags') !== undefined) {
      const parsed = AssetTag.parse(cell('tags'));
      if (parsed.error) fail(parsed.error); else tags = parsed.tags;
    }

    // 狀態
    let isActive;
    const statusCell = cell('status');
    if (statusCell) {
      const s = statusCell.toLowerCase();
      if (STATUS_ON.includes(s)) isActive = true;
      else if (STATUS_OFF.includes(s)) isActive = false;
      else fail(`狀態「${statusCell}」看不懂（請填「啟用」或「停用」）`);
    }

    // 自訂欄位
    let custom = {};
    if (!row.errors.length && customCols.length) {
      const cbody = {};
      for (const c of customCols) {
        let v = csv.stripFormulaGuard(String(cells[c.index] == null ? '' : cells[c.index])).trim();
        if (!AssetField.appliesTo(c.def, category)) {
          if (v !== '') row.warnings.push(`「${c.def.label}」不適用於類別「${labels[category] || category}」，已忽略`);
          continue;
        }
        if (c.def.type === 'date') v = normalizeDate(v);
        if (c.def.type === 'boolean' && v) {
          const l = v.toLowerCase();
          v = BOOL_ON.includes(l) ? '1' : (BOOL_OFF.includes(l) ? '0' : v);
        }
        cbody[`cf_${c.def.id}`] = v;
      }
      const parsed = AssetField.parse(cbody, category, current ? (valuesByAsset.get(current.id) || {}) : {});
      if (parsed.error) fail(parsed.error); else custom = parsed.values;
    }

    // 新增：同名同類別已存在（資料庫或檔案前面幾列）就擋
    if (mode === 'create' && name && category) {
      const key = nameKey(name, category);
      if (existingNames.has(key)) fail(`已經有同名同類別的設備（資產ID ${existingNames.get(key)}）。要更新它請在「資產ID」欄填入 ${existingNames.get(key)}，要新增請改名`);
      else if (seenNames.has(key)) fail('檔案裡前面已經有同名同類別的設備');
      seenNames.add(key);
    }

    if (row.errors.length) continue;

    // 格式與重複的提醒（不擋）
    const candidate = { id: current ? current.id : undefined, ...fields.values };
    row.warnings.push(...assetFields.warningsFor(candidate, dupIndex));

    // 差異（更新）
    if (current) {
      const diff = (label, from, to) => {
        if ((from || '') !== (to || '')) {
          row.changes.push({ label, from: from || '', to: to || '' });
          if (!to && from) result.summary.clears++;
        }
      };
      diff('資產名稱', current.name, name);
      diff('類別', labels[current.category] || current.category, labels[category] || category);
      diff('位置', current.location, location);
      diff('備註', current.notes, notes);
      for (const f of assetFields.FIELDS) diff(f.label, current[f.key], fields.values[f.key]);
      if (tags !== undefined) diff('標籤', (current.tags || []).slice().sort().join('、'), tags.slice().sort().join('、'));
      if (isActive !== undefined) diff('狀態', current.is_active ? '啟用' : '停用', isActive ? '啟用' : '停用');
      const before = valuesByAsset.get(current.id) || {};
      for (const c of customCols) {
        if (!(c.def.id in custom)) continue;
        diff(c.def.label, displayCustom(c.def, before[c.def.id]), displayCustom(c.def, custom[c.def.id]));
      }
      row.action = row.changes.length ? 'update' : 'unchanged';
    } else {
      row.action = 'create';
    }
    row.apply = {
      mode, id: current ? current.id : null, name, category, location, notes, values: fields.values, tags, custom,
      is_active: isActive, identifier: current ? current.identifier : null, currentActive: current ? !!current.is_active : true,
    };
    if (row.warnings.length) result.summary.warnings += row.warnings.length;
  }

  for (const r of result.rows) result.summary[r.action === 'error' ? 'error' : r.action]++;
  return result;
}

// ---------- 套用 ----------

function apply(planResult) {
  const out = { created: 0, updated: 0 };
  db.transaction(() => {
    for (const row of planResult.rows) {
      if (row.action !== 'create' && row.action !== 'update') continue;
      const a = row.apply;
      if (a.mode === 'create') {
        const asset = Asset.create({ name: a.name, category: a.category, location: a.location, notes: a.notes, ...a.values, custom: a.custom, tags: a.tags });
        if (a.is_active === false) Asset.setActive(asset.id, false);
        out.created++;
      } else {
        Asset.update(a.id, {
          name: a.name, category: a.category, location: a.location, notes: a.notes, ...a.values,
          identifier: a.identifier, is_active: a.is_active !== undefined ? a.is_active : a.currentActive,
          custom: a.custom, tags: a.tags,
        });
        out.updated++;
      }
    }
  })();
  return out;
}

// ---------- 暫存（預覽 → 確認之間保存上傳的內容；放記憶體，30 分鐘過期，每人一份） ----------

const pending = new Map();
function cleanupPending() {
  const now = Date.now();
  for (const [token, v] of pending) if (v.expires < now) pending.delete(token);
}
function savePending(userId, data) {
  cleanupPending();
  for (const [token, v] of pending) if (v.userId === userId) pending.delete(token);
  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { userId, ...data, expires: Date.now() + PENDING_TTL_MS });
  return token;
}
function getPending(userId, token) {
  cleanupPending();
  const v = pending.get(String(token || ''));
  return v && v.userId === userId ? v : null;
}
function dropPending(token) { pending.delete(String(token || '')); }

module.exports = { FIXED, MAX_ROWS, exportCsv, templateCsv, plan, apply, savePending, getPending, dropPending };
