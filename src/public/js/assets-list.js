// 資產管理列表：類別分組可摺疊；篩選下拉選單一改就自動套用（沒有 JavaScript 時按「搜尋」鈕一樣能用）
(function () {
  document.querySelectorAll('.group-row .group-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const row = btn.closest('.group-row');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.querySelector('.group-toggle__icon').textContent = open ? '▾' : '▸';
      const code = row.dataset.group;
      document.querySelectorAll('tr[data-g]').forEach(function (tr) {
        if (tr.dataset.g === code) tr.hidden = !open;
      });
    });
  });

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
