// 待處理項目：篩選下拉選單一改就自動套用（沒有 JavaScript 時用「套用」鈕）
(function () {
  const form = document.getElementById('issue-filter');
  if (!form) return;
  form.querySelectorAll('select').forEach(function (s) { s.addEventListener('change', function () { form.submit(); }); });
})();
