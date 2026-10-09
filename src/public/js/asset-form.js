// 資產編輯頁：自訂欄位只在「適用的類別」顯示。改了類別就即時顯示／隱藏；
// 被隱藏的欄位同時停用（停用的欄位不會送出，伺服器就會保留它原本的值）。
(function () {
  // 標籤：點一下「現有標籤」把它加進（或移出）輸入框，免得每次手打、打成不同寫法
  const tagInput = document.getElementById('tags');
  const suggest = document.getElementById('tag-suggest');
  if (tagInput && suggest) {
    const parse = function () { return tagInput.value.split(/[,，、;；\n]+/).map(function (t) { return t.trim(); }).filter(Boolean); };
    const sync = function () {
      const have = parse().map(function (t) { return t.toLowerCase(); });
      suggest.querySelectorAll('.tag-chip').forEach(function (b) { b.classList.toggle('is-on', have.indexOf(b.dataset.tag.toLowerCase()) !== -1); });
    };
    suggest.addEventListener('click', function (e) {
      const b = e.target.closest('.tag-chip');
      if (!b) return;
      const tag = b.dataset.tag;
      const list = parse();
      const i = list.map(function (t) { return t.toLowerCase(); }).indexOf(tag.toLowerCase());
      if (i === -1) list.push(tag); else list.splice(i, 1);
      tagInput.value = list.join(', ');
      sync();
    });
    tagInput.addEventListener('input', sync);
    sync();
  }

  const select = document.getElementById('category');
  const fields = document.querySelectorAll('.cf-field');
  const section = document.getElementById('custom-section');
  if (!select || select.disabled || fields.length === 0) return;

  function refresh() {
    fields.forEach(function (f) {
      const cats = (f.dataset.cats || '').split(',').filter(Boolean);
      const show = cats.length === 0 || cats.indexOf(select.value) !== -1;
      f.hidden = !show;
      f.querySelectorAll('input, select').forEach(function (el) { el.disabled = !show; });
    });
    // 目前這個類別一個自訂欄位都沒有時，連「自訂欄位」區塊標題一起隱藏
    if (section) section.hidden = !Array.prototype.some.call(fields, function (f) { return !f.hidden; });
  }
  select.addEventListener('change', refresh);
  refresh();
})();
