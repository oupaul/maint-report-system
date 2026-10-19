// 批次摘要頁：選擇要輸出報告的客戶（全選／全不選；一家都沒選時停用下載鈕；點外面關閉），
// 以及「附錄原圖頁」選項（勾了，下載連結與選客戶表單都會帶 appendix=1）
(function () {
  const appendix = document.getElementById('report-appendix');
  const mainLink = document.getElementById('report-main-link');
  const appendixField = document.getElementById('report-appendix-field');
  if (appendix) {
    const base = mainLink ? mainLink.getAttribute('href').split('?')[0] : null;
    appendix.addEventListener('change', function () {
      if (mainLink) mainLink.setAttribute('href', base + (appendix.checked ? '?appendix=1' : ''));
      if (appendixField) appendixField.disabled = !appendix.checked;
    });
  }

  const form = document.getElementById('report-picker-form');
  if (!form) return;
  const boxes = Array.prototype.slice.call(form.querySelectorAll('input[name="customer"]'));
  const buttons = [document.getElementById('report-pdf-btn'), document.getElementById('report-zip-btn')];
  function refresh() {
    const any = boxes.some(function (b) { return b.checked; });
    buttons.forEach(function (btn) { if (btn) btn.disabled = !any; });
  }
  boxes.forEach(function (b) { b.addEventListener('change', refresh); });
  document.getElementById('report-pick-all').addEventListener('click', function () { boxes.forEach(function (b) { b.checked = true; }); refresh(); });
  document.getElementById('report-pick-none').addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); refresh(); });
  const picker = document.getElementById('report-picker');
  document.addEventListener('click', function (e) { if (picker.open && !picker.contains(e.target)) picker.open = false; });
  refresh();
})();
