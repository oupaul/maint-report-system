// 建立巡檢批次頁面的「快速新增設備」：點一下按鈕複製一列空白輸入框，
// 不需要框架，複製第一列 DOM 節點並清空欄位值即可。
(function () {
  const container = document.getElementById('new-asset-rows');
  const addBtn = document.getElementById('add-asset-row');
  if (!container || !addBtn) return;

  addBtn.addEventListener('click', function () {
    const first = container.querySelector('.new-asset-row');
    const clone = first.cloneNode(true);
    clone.querySelectorAll('input').forEach((el) => { el.value = ''; });
    clone.querySelectorAll('select').forEach((el) => { el.selectedIndex = 0; });
    container.appendChild(clone);
  });
})();
