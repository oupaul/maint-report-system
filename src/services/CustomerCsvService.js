// 客戶 CSV 匯出／匯入（規則與資產匯入一致：先預覽、確認後才寫入、確認時重新規劃、單一交易、錯誤的列略過）。
// - 對應方式：有「客戶ID」就以 ID 為準（可以改名）；沒有 ID 就以「客戶名稱」對應（不分大小寫）——找到就更新，找不到就新增。
// - 空白儲存格：欄位存在但空白＝清空（簡稱／備註）；整欄不存在＝不動。狀態空白＝不動（狀態不能清空）。
// - 匯入不會刪除客戶；「設備數」欄只是匯出給你看，匯入時忽略。
const db = require('../models/db');
const Customer = require('../models/Customer');
const csv = require('../utils/csv');
const AssetCsvService = require('./AssetCsvService');

const MAX_ROWS = 2000;
const COLUMNS = [
  { key: 'id', label: '客戶ID', aliases: ['id', 'customer_id', 'customerid'] },
  { key: 'name', label: '客戶名稱', aliases: ['名稱', 'name', 'customer', 'customername'] },
  { key: 'code', label: '簡稱／代碼', aliases: ['簡稱', '代碼', '簡稱代碼', '簡稱/代碼', 'code'] },
  { key: 'notes', label: '備註', aliases: ['notes', 'note'] },
  { key: 'status', label: '狀態', aliases: ['status', 'is_active'] },
  { key: 'asset_count', label: '設備數', aliases: ['assets', 'assetcount'], ignored: true },
];
const ON = ['啟用', '啟用中', '1', 'true', 'yes', 'y', '是', 'active', 'on'];
const OFF = ['停用', '已停用', '0', 'false', 'no', 'n', '否', 'inactive', 'off'];
const norm = (s) => String(s == null ? '' : s).replace(/^﻿/, '').replace(/\s+/g, '').toLowerCase();

function exportCsv() {
  const rows = [['客戶ID', '客戶名稱', '簡稱／代碼', '備註', '狀態', '設備數']];
  Customer.findAll().forEach(c => rows.push([c.id, c.name, c.code || '', c.notes || '', c.is_active ? '啟用' : '停用', c.asset_count]));
  return csv.toCsv(rows);
}

const templateCsv = () => csv.toCsv([['客戶ID', '客戶名稱', '簡稱／代碼', '備註', '狀態']]);

function plan(table) {
  const out = { fileErrors: [], ignoredColumns: [], rows: [], summary: { create: 0, update: 0, unchanged: 0, error: 0, clears: 0 } };
  if (!table || table.length < 2) { out.fileErrors.push('檔案裡沒有資料列（第一列要是表頭）'); return out; }
  const byName = new Map();
  COLUMNS.forEach(c => [c.label, ...c.aliases].forEach(n => byName.set(norm(n), c)));
  const cols = new Map(); // key → index
  table[0].forEach((raw, i) => {
    const n = norm(raw);
    if (!n) return;
    const c = byName.get(n);
    if (!c) { out.ignoredColumns.push(String(raw).trim()); return; }
    if (c.ignored) return;
    if (cols.has(c.key)) out.fileErrors.push(`欄位「${c.label}」重複出現了`); else cols.set(c.key, i);
  });
  if (!cols.has('id') && !cols.has('name')) out.fileErrors.push('找不到「客戶名稱」或「客戶ID」欄位，請確認第一列是表頭（建議從「下載匯入範本」開始）');
  const data = table.slice(1).map((cells, i) => ({ cells, line: i + 2 })).filter(r => r.cells.some(c => String(c).trim() !== ''));
  if (data.length === 0) out.fileErrors.push('檔案裡沒有資料列');
  if (data.length > MAX_ROWS) out.fileErrors.push(`一次最多匯入 ${MAX_ROWS} 筆（這個檔案有 ${data.length} 筆）`);
  if (out.fileErrors.length) return out;

  const all = Customer.findAll();
  const byId = new Map(all.map(c => [c.id, c]));
  const byLower = new Map(all.map(c => [c.name.toLowerCase(), c]));
  const claimed = new Map(); // 檔案裡已經用掉的名稱（小寫）→ 列號，抓檔案內重複
  const claimedIds = new Set();
  const cell = (cells, key) => (cols.has(key) ? csv.stripFormulaGuard(String(cells[cols.get(key)] == null ? '' : cells[cols.get(key)])).trim() : undefined);

  for (const { cells, line } of data) {
    const row = { line, action: 'error', errors: [], changes: [], name: cell(cells, 'name') || '', id: null, apply: null };
    out.rows.push(row);
    let current = null;
    const rawId = cell(cells, 'id');
    if (rawId) {
      if (!/^\d+$/.test(rawId)) row.errors.push(`客戶ID「${rawId}」不是數字`);
      else { current = byId.get(Number(rawId)) || null; if (!current) row.errors.push(`找不到客戶ID ${rawId}`); }
    }
    const nameCell = cell(cells, 'name');
    let name = nameCell !== undefined ? String(nameCell).replace(/\s+/g, ' ').trim() : (current ? current.name : '');
    if (!rawId && nameCell !== undefined && name) {
      current = byLower.get(name.toLowerCase()) || null; // 沒有 ID：用名稱對應（名稱就是鍵，大小寫不同不視為改名）
      if (current) name = current.name;
    }
    if (row.errors.length) continue;
    if (!name) { row.errors.push('客戶名稱不能空白'); continue; }
    row.name = name;
    row.id = current ? current.id : null;

    const code = cell(cells, 'code') !== undefined ? cell(cells, 'code') : (current ? (current.code || '') : '');
    const notes = cell(cells, 'notes') !== undefined ? cell(cells, 'notes') : (current ? (current.notes || '') : '');
    const v = Customer.validate({ name, code, notes }, current ? current.id : null);
    if (v.error) { row.errors.push(v.error); continue; }

    let isActive;
    const st = cell(cells, 'status');
    if (st) {
      const s = st.toLowerCase();
      if (ON.includes(s)) isActive = true; else if (OFF.includes(s)) isActive = false;
      else { row.errors.push(`狀態「${st}」看不懂（請填「啟用」或「停用」）`); continue; }
    }

    if (current && claimedIds.has(current.id)) { row.errors.push('檔案裡前面已經有同一個客戶（同 ID 或同名），請不要重複'); continue; }
    const key = name.toLowerCase();
    if (claimed.has(key)) { row.errors.push(`檔案裡第 ${claimed.get(key)} 列已經有同名的客戶`); continue; }
    claimed.set(key, line);
    if (current) claimedIds.add(current.id);

    if (current) {
      const diff = (label, from, to) => {
        if ((from || '') !== (to || '')) {
          row.changes.push({ label, from: from || '', to: to || '' });
          if (!to && from) out.summary.clears++;
        }
      };
      diff('客戶名稱', current.name, v.value.name);
      diff('簡稱／代碼', current.code, v.value.code);
      diff('備註', current.notes, v.value.notes);
      if (isActive !== undefined) diff('狀態', current.is_active ? '啟用' : '停用', isActive ? '啟用' : '停用');
      row.action = row.changes.length ? 'update' : 'unchanged';
    } else {
      row.action = 'create';
    }
    row.apply = { id: current ? current.id : null, value: v.value, is_active: isActive, currentActive: current ? !!current.is_active : true };
  }
  for (const r of out.rows) out.summary[r.action === 'error' ? 'error' : r.action]++;
  return out;
}

function apply(planResult) {
  const result = { created: 0, updated: 0 };
  db.transaction(() => {
    for (const row of planResult.rows) {
      if (row.action !== 'create' && row.action !== 'update') continue;
      const a = row.apply;
      if (a.id) {
        Customer.update(a.id, a.value);
        if (a.is_active !== undefined) Customer.setActive(a.id, a.is_active);
        result.updated++;
      } else {
        const c = Customer.create(a.value);
        if (a.is_active === false) Customer.setActive(c.id, false);
        result.created++;
      }
    }
  })();
  return result;
}

module.exports = { MAX_ROWS, exportCsv, templateCsv, plan, apply };
