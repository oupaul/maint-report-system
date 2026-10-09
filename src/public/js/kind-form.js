// 設備類型管理：選「容量型」才顯示警告／異常門檻欄位
(function () {
  document.querySelectorAll('.kind-form').forEach(function (form) {
    const sel = form.querySelector('select[name=input_kind]');
    const box = form.querySelector('.kind-form__pct');
    if (!sel || !box) return;
    sel.addEventListener('change', function () { box.hidden = sel.value !== 'capacity'; });
  });
})();
