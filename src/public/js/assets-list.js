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
