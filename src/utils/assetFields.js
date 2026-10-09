// 資產的識別欄位（IP 位址、主機名稱、序號、財產編號）：整理輸入、檢查格式、找重複。
// 格式有問題或重複只提示、不擋存檔（舊資料本來就可能重複或格式不一）。
const net = require('net');

const FIELDS = [
  { key: 'ip_address', label: 'IP 位址', max: 200 },
  { key: 'mac_address', label: 'MAC 位址', max: 200 },
  { key: 'hostname', label: '主機名稱', max: 100 },
  { key: 'serial_number', label: '序號', max: 100 },
  { key: 'asset_tag', label: '財產編號', max: 100 },
  { key: 'brand', label: '廠牌', max: 100 },
  { key: 'model', label: '型號', max: 100 },
  { key: 'purchase_date', label: '購置日期', max: 10 },
];
const DUPLICATE_CHECKED = ['ip_address', 'mac_address', 'hostname', 'serial_number', 'asset_tag']; // 廠牌／型號／日期本來就會重複

// 一個欄位可以放多個值（例如多張網卡）：IP、MAC
const MULTI = ['ip_address', 'mac_address'];

function splitIps(value) {
  return String(value || '').split(/[\s,;，；]+/).filter(Boolean);
}

// MAC：12 個十六進位字元，分隔符號可以是 : - . 或沒有（AA:BB:CC:DD:EE:FF／aa-bb-cc-dd-ee-ff／aabb.ccdd.eeff／aabbccddeeff），
// 統一存成大寫加冒號。看不懂的原樣保留（只提示不擋存檔）
function formatMac(token) {
  const hex = token.replace(/[:\-.]/g, '');
  return /^[0-9a-fA-F]{12}$/.test(hex) ? hex.toUpperCase().match(/.{2}/g).join(':') : token;
}
const isMac = (t) => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(formatMac(t));
const splitMulti = splitIps;

function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}

// 整理表單送來的欄位：去頭尾空白、IP 統一成「a, b」格式、空字串變 null；回傳 { values, error }
function normalize(body) {
  const values = {};
  for (const f of FIELDS) {
    let v = String(body[f.key] == null ? '' : body[f.key]).trim();
    if (f.key === 'ip_address') v = splitIps(v).join(', ');
    if (f.key === 'mac_address') v = splitMulti(v).map(formatMac).join(', ');
    if (v.length > f.max) return { values, error: `「${f.label}」太長了（最多 ${f.max} 個字元）` };
    if (f.key === 'purchase_date' && v && !isRealDate(v)) return { values, error: '「購置日期」格式不正確，請用 年-月-日（例如 2024-03-15）' };
    values[f.key] = v || null;
  }
  return { values, error: null };
}

// 沒有 identifier 這個欄位的表單（新增、或不顯示舊欄位時）要保留資料庫原值，所以這裡只在有送出時才回傳
function legacyIdentifier(body, current) {
  if (!Object.prototype.hasOwnProperty.call(body, 'identifier')) return current || null;
  const v = String(body.identifier || '').trim();
  return v ? v.slice(0, 200) : null;
}

function invalidIps(asset) {
  return splitIps(asset.ip_address).filter(t => net.isIP(t) === 0);
}

function invalidMacs(asset) {
  return splitMulti(asset.mac_address).filter(t => !isMac(t));
}

const norm = (s) => String(s || '').trim().toLowerCase();

// 找出和這台設備重複的其他設備：serial / asset_tag / hostname 以全文比對（不分大小寫）；IP 逐個比對。
// allAssets 傳入所有設備（資料量小，直接在記憶體比對，也能涵蓋已停用的設備）
function findDuplicates(asset, allAssets) {
  const out = [];
  const others = allAssets.filter(a => a.id !== asset.id);
  for (const f of FIELDS.filter(x => DUPLICATE_CHECKED.includes(x.key))) {
    if (MULTI.includes(f.key)) {
      for (const val of splitMulti(asset[f.key])) {
        const hit = others.filter(a => splitMulti(a[f.key]).some(x => norm(x) === norm(val)));
        if (hit.length) out.push({ field: f.label, value: val, names: hit.map(a => a.name) });
      }
    } else if (norm(asset[f.key])) {
      const hit = others.filter(a => norm(a[f.key]) === norm(asset[f.key]));
      if (hit.length) out.push({ field: f.label, value: asset[f.key], names: hit.map(a => a.name) });
    }
  }
  return out;
}

// 給畫面用的提示文字清單
function warningsFor(asset, allAssets) {
  const w = [];
  const bad = invalidIps(asset);
  if (bad.length) w.push(`IP 位址格式看起來不正確：${bad.join('、')}（多個 IP 請用逗號分隔）`);
  const badMac = invalidMacs(asset);
  if (badMac.length) w.push(`MAC 位址格式看起來不正確：${badMac.join('、')}（應為 12 個十六進位字元，例如 AA:BB:CC:DD:EE:FF；多個請用逗號分隔）`);
  for (const d of findDuplicates(asset, allAssets)) {
    w.push(`${d.field}「${d.value}」與其他設備重複：${d.names.slice(0, 5).join('、')}${d.names.length > 5 ? ' 等' : ''}`);
  }
  return w;
}

module.exports = { FIELDS, normalize, legacyIdentifier, invalidIps, invalidMacs, formatMac, findDuplicates, warningsFor, splitIps };
