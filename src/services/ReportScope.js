// 巡檢報告（PDF）要輸出哪些客戶：一個批次可以涵蓋多家客戶（含「未指定客戶」的設備），
// 報告可以輸出全部，或只輸出選到的客戶，也可以每家客戶各出一份。
// 選取用網址參數 customer（可重複）：客戶 id 或 none（未指定客戶）。不存任何新資料。

// 依設備順序（getAssets 已是「客戶名稱 → 未指定排最後」）整理出可選的客戶群組，附台數與異常項目數
function groupsOf(assets, itemsByAssetId) {
  const groups = new Map();
  for (const a of assets) {
    const key = a.customer_id ? String(a.customer_id) : 'none';
    if (!groups.has(key)) groups.set(key, { key, id: a.customer_id || null, name: a.customer_name || '未指定客戶', taxId: a.customer_tax_id || null, assetCount: 0, abnormal: 0 });
    const g = groups.get(key);
    g.assetCount++;
    for (const it of (itemsByAssetId && itemsByAssetId.get(a.id)) || []) if (it.status === 'warning' || it.status === 'critical') g.abnormal++;
  }
  return [...groups.values()];
}

// 從網址參數取出選到的群組 key（只收這個批次真的有的）。沒帶參數＝null（全部）
function parseSelection(query, groups) {
  const raw = query.customer;
  if (raw === undefined) return null;
  const list = (Array.isArray(raw) ? raw : [raw]).map(String);
  const valid = new Set(groups.map(g => g.key));
  return new Set(list.filter(k => valid.has(k)));
}

const pick = (assets, keys) => assets.filter(a => keys.has(a.customer_id ? String(a.customer_id) : 'none'));

// 檔名用：去掉路徑與特殊字元、限制長度
function fileSafe(name, max = 40) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, '').slice(0, max) || 'customer';
}

// Content-Disposition：ASCII 後備檔名 ＋ UTF-8 的 filename*（瀏覽器優先用後者，中文檔名正常）
function contentDisposition(type, asciiName, utf8Name) {
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(utf8Name).replace(/['()]/g, escape)}`;
}

module.exports = { groupsOf, parseSelection, pick, fileSafe, contentDisposition };
