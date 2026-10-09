// 自訂欄位管理：只有「下拉選單」類型才顯示選項輸入框（沒有 JavaScript 時一律顯示）
(function () {
  const type = document.getElementById('type');
  const group = document.getElementById('options-group');
  if (!type || !group) return;
  function refresh() { group.hidden = type.value !== 'select'; }
  type.addEventListener('change', refresh);
  refresh();
})();
