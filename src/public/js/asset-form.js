// 資產編輯頁：自訂欄位只在「適用的類別」顯示。改了類別就即時顯示／隱藏；
// 被隱藏的欄位同時停用（停用的欄位不會送出，伺服器就會保留它原本的值）。
(function () {
  const select = document.getElementById('category');
  const fields = document.querySelectorAll('.cf-field');
  if (!select || select.disabled || fields.length === 0) return;

  function refresh() {
    fields.forEach(function (f) {
      const cats = (f.dataset.cats || '').split(',').filter(Boolean);
      const show = cats.length === 0 || cats.indexOf(select.value) !== -1;
      f.hidden = !show;
      f.querySelectorAll('input, select').forEach(function (el) { el.disabled = !show; });
    });
  }
  select.addEventListener('change', refresh);
  refresh();
})();
