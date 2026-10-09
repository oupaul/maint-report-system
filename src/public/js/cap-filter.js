// 容量預警：客戶下拉選單改了就自動套用
(function () {
  const form = document.getElementById('cap-filter');
  if (!form) return;
  form.querySelectorAll('select').forEach(function (s) { s.addEventListener('change', function () { form.submit(); }); });
})();
