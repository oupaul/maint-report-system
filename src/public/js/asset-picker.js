// 設備挑選器（partials/asset-picker.ejs）：搜尋、類型／位置篩選、群組摺疊、全選、只看已勾選、
// 帶入舊批次的設備。被篩掉（隱藏）的設備勾選狀態一律保留、送出表單時照樣會送出——
// 篩選只是「顯示」的事，不會改變已勾選的內容。
(function () {
  const root = document.getElementById('asset-picker');
  if (!root) return;

  const search = root.querySelector('.ap-search');
  const locSel = root.querySelector('.ap-location');
  const tagSel = root.querySelector('.ap-tag');
  const chips = Array.prototype.slice.call(root.querySelectorAll('.ap-chip'));
  const groups = Array.prototype.slice.call(root.querySelectorAll('.ap-group'));
  const tiles = Array.prototype.slice.call(root.querySelectorAll('.ap-tile'));
  const onlyBox = root.querySelector('.ap-only');
  const countEl = root.querySelector('.ap-count');
  const emptyEl = root.querySelector('.ap-empty');
  const total = tiles.length;
  const AUTO_OPEN_LIMIT = 12; // 設備不多時全部展開；多的時候只展開有勾選或符合條件的類型

  let batches = [];
  try { batches = JSON.parse(root.dataset.batches || '[]'); } catch (e) { batches = []; }

  const state = { q: '', cat: '', loc: '', tag: '', only: false };
  const tileTags = new Map(); // 每個設備的標籤清單（JSON 存在 data-tags）
  tiles.forEach(function (t) { let a = []; try { a = JSON.parse(t.dataset.tags || '[]'); } catch (e) { a = []; } tileTags.set(t, a); });
  let firstPass = true;     // 第一次整理：套用預設展開規則（設備多就先摺起來）
  let wasFiltering = false; // 剛從「篩選中」回到「沒有篩選」：同樣套用預設規則；其餘時候不去動使用者手動展開／摺疊的狀態
  const box = (tile) => tile.querySelector('input[type=checkbox]');

  function filtersActive() { return !!(state.q || state.cat || state.loc || state.tag || state.only); }

  function refresh() {
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let visibleTotal = 0;
    tiles.forEach(function (tile) {
      const match = tokens.every(function (t) { return tile.dataset.search.indexOf(t) !== -1; }) &&
        (!state.cat || tile.dataset.cat === state.cat) &&
        (!state.loc || tile.dataset.loc === state.loc) &&
        (!state.tag || tileTags.get(tile).indexOf(state.tag) !== -1) &&
        (!state.only || box(tile).checked);
      tile.hidden = !match;
      if (match) visibleTotal++;
    });
    groups.forEach(function (g) {
      const gt = Array.prototype.slice.call(g.querySelectorAll('.ap-tile'));
      const visible = gt.filter(function (t) { return !t.hidden; }).length;
      const checked = gt.filter(function (t) { return box(t).checked; }).length;
      g.hidden = visible === 0;
      g.querySelector('.ap-group__count').textContent = (filtersActive() ? visible + ' / ' + gt.length : gt.length) + ' 台' + (checked ? '・已選 ' + checked : '');
      if (visible > 0) {
        if (filtersActive()) g.open = true;
        else if (firstPass || wasFiltering) g.open = total <= AUTO_OPEN_LIMIT || checked > 0;
      }
    });
    firstPass = false;
    wasFiltering = filtersActive();
    chips.forEach(function (c) { c.classList.toggle('is-active', c.dataset.cat === state.cat); });
    const selected = tiles.filter(function (t) { return box(t).checked; }).length;
    countEl.textContent = '已選 ' + selected + ' 台';
    emptyEl.hidden = visibleTotal !== 0;
  }

  if (search) {
    search.addEventListener('input', function () { state.q = search.value; refresh(); });
    // 在搜尋框按 Enter 不要送出整份表單
    search.addEventListener('keydown', function (e) { if (e.key === 'Enter') e.preventDefault(); });
  }
  if (locSel) locSel.addEventListener('change', function () { state.loc = locSel.value; refresh(); });
  if (tagSel) tagSel.addEventListener('change', function () { state.tag = tagSel.value; refresh(); });
  chips.forEach(function (c) { c.addEventListener('click', function () { state.cat = c.dataset.cat; refresh(); }); });
  if (onlyBox) onlyBox.addEventListener('change', function () { state.only = onlyBox.checked; refresh(); });

  root.querySelector('.ap-select-visible').addEventListener('click', function () {
    tiles.forEach(function (t) { if (!t.hidden) box(t).checked = true; });
    refresh();
  });
  root.querySelector('.ap-clear').addEventListener('click', function () {
    tiles.forEach(function (t) { box(t).checked = false; });
    refresh();
  });
  groups.forEach(function (g) {
    // 按鈕放在 <summary> 裡：要擋掉預設行為，不然按下去會順便把這個區塊摺起來／展開
    g.querySelector('.ap-group-select').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      g.querySelectorAll('.ap-tile').forEach(function (t) { if (!t.hidden) box(t).checked = true; });
      refresh();
    });
  });
  tiles.forEach(function (t) { box(t).addEventListener('change', refresh); });

  const applyBtn = root.querySelector('.ap-apply-batch');
  if (applyBtn) {
    applyBtn.addEventListener('click', function () {
      const sel = root.querySelector('.ap-batch');
      const batch = batches.filter(function (b) { return String(b.id) === sel.value; })[0];
      const msg = root.querySelector('.ap-batch-msg');
      if (!batch) return;
      const byId = {};
      tiles.forEach(function (t) { byId[t.dataset.id] = t; });
      let applied = 0;
      let missing = 0;
      batch.assets.forEach(function (id) {
        const t = byId[String(id)];
        if (t) { box(t).checked = true; applied++; } else { missing++; }
      });
      msg.textContent = '已帶入 ' + applied + ' 台' + (missing ? '（另有 ' + missing + ' 台已停用或不在可選清單中，沒有帶入）' : '') + '。可以再微調勾選。';
      refresh();
    });
  }

  refresh();
})();
