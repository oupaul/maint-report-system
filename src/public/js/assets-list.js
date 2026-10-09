// 資產管理列表：類別分組可摺疊（記住收合狀態）、全部展開／收合、欄位顯示選擇（記在這個瀏覽器）；
// 篩選下拉選單一改就自動套用（沒有 JavaScript 時按「搜尋」鈕一樣能用）
(function () {
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 無痕視窗等情況：只是不記住 */ } }

  // ---- 分組 ----
  const GROUP_KEY = 'assetList.collapsedGroups';
  const groupRows = Array.prototype.slice.call(document.querySelectorAll('.group-row'));
  function setGroup(row, open) {
    const btn = row.querySelector('.group-toggle');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.querySelector('.group-toggle__icon').textContent = open ? '▾' : '▸';
    document.querySelectorAll('tr[data-g]').forEach(function (tr) {
      if (tr.dataset.g === row.dataset.group) tr.hidden = !open;
    });
  }
  function saveGroups() {
    save(GROUP_KEY, groupRows.filter(function (r) { return r.querySelector('.group-toggle').getAttribute('aria-expanded') !== 'true'; })
      .map(function (r) { return r.dataset.group; }));
  }
  groupRows.forEach(function (row) {
    row.querySelector('.group-toggle').addEventListener('click', function () {
      setGroup(row, row.querySelector('.group-toggle').getAttribute('aria-expanded') !== 'true');
      saveGroups();
    });
  });
  const closed = load(GROUP_KEY);
  if (Array.isArray(closed)) groupRows.forEach(function (row) { if (closed.indexOf(row.dataset.group) !== -1) setGroup(row, false); });
  const expandAll = document.getElementById('groups-expand');
  const collapseAll = document.getElementById('groups-collapse');
  if (expandAll && collapseAll) {
    expandAll.hidden = false; collapseAll.hidden = false;
    expandAll.addEventListener('click', function () { groupRows.forEach(function (r) { setGroup(r, true); }); saveGroups(); });
    collapseAll.addEventListener('click', function () { groupRows.forEach(function (r) { setGroup(r, false); }); saveGroups(); });
  }

  // ---- 欄位顯示 ----
  const COL_KEY = 'assetList.columns';
  const table = document.querySelector('.asset-table');
  const chooser = document.getElementById('col-chooser');
  const toggles = Array.prototype.slice.call(document.querySelectorAll('[data-col-toggle]'));
  if (table && chooser && toggles.length) {
    const defaults = toggles.filter(function (t) { return t.dataset.default === '1'; }).map(function (t) { return t.dataset.colToggle; });
    function applyCols(list) {
      const vis = {};
      list.forEach(function (k) { vis[k] = true; });
      toggles.forEach(function (t) { t.checked = !!vis[t.dataset.colToggle]; });
      table.querySelectorAll('[data-col]').forEach(function (c) { c.hidden = !vis[c.dataset.col]; });
      // 分組標題列要橫跨目前顯示的所有欄
      const n = table.querySelectorAll('thead th:not([hidden])').length;
      table.querySelectorAll('.group-row td').forEach(function (td) { td.colSpan = n; });
    }
    const stored = load(COL_KEY);
    applyCols(Array.isArray(stored) ? stored : defaults);
    chooser.hidden = false;
    toggles.forEach(function (t) {
      t.addEventListener('change', function () {
        const list = toggles.filter(function (x) { return x.checked; }).map(function (x) { return x.dataset.colToggle; });
        save(COL_KEY, list); applyCols(list);
      });
    });
    document.getElementById('col-reset').addEventListener('click', function () { save(COL_KEY, defaults); applyCols(defaults); });
    document.addEventListener('click', function (e) { if (chooser.open && !chooser.contains(e.target)) chooser.open = false; });
  }

  const form = document.getElementById('asset-filter');
  if (form) {
    form.querySelectorAll('select').forEach(function (sel) {
      sel.addEventListener('change', function () { form.submit(); });
    });
  }
})();

// 批次設定客戶：勾選設備、更新「套用到已選的 N 台」按鈕
(function () {
  const bar = document.getElementById('bulk-bar');
  if (!bar) return;
  const boxes = Array.prototype.slice.call(document.querySelectorAll('.row-check'));
  const all = document.getElementById('select-all');
  const apply = document.getElementById('bulk-apply');
  const count = document.getElementById('bulk-count');
  const scopeAll = document.getElementById('bulk-all');
  function refresh() {
    const n = boxes.filter(function (b) { return b.checked; }).length;
    count.textContent = n;
    apply.disabled = !(n > 0 || scopeAll.checked);
    if (all) all.checked = boxes.length > 0 && n === boxes.length;
  }
  boxes.forEach(function (b) { b.addEventListener('change', refresh); });
  if (all) all.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = all.checked; }); refresh(); });
  scopeAll.addEventListener('change', refresh);
  refresh();
})();
