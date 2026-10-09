// 「系統通知」頁的快速範本：把「幾分鐘後開始、預計維護多久」組成一段可以再修改的訊息填進訊息欄。
// 時間用台北時間顯示（不依賴使用者電腦的時區設定）。
(function () {
  const btn = document.getElementById('ann-apply');
  const msg = document.getElementById('message');
  if (!btn || !msg) return;

  function taipeiHHMM(date) {
    return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  btn.addEventListener('click', function () {
    const inMin = Math.max(1, parseInt(document.getElementById('ann-in').value, 10) || 10);
    const forMin = Math.max(1, parseInt(document.getElementById('ann-for').value, 10) || 15);
    const at = taipeiHHMM(new Date(Date.now() + inMin * 60 * 1000));
    msg.value = '系統將於 ' + at + '（約 ' + inMin + ' 分鐘後）進行更新維護，預計 ' + forMin +
      ' 分鐘，期間無法使用。請儘快儲存正在填寫的內容，維護完成後再重新整理頁面繼續使用。';
    msg.focus();
  });
})();
