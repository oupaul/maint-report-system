// 導覽列「通知」的未讀數字：頁面開著時每 60 秒悄悄更新一次，不用整頁重新載入。
// 只在分頁可見時才查，避免背景分頁白白打請求。
(function () {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  function refresh() {
    if (document.hidden) return;
    fetch('/notifications/unread-count', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || typeof data.count !== 'number') return;
        badge.textContent = String(data.count);
        badge.hidden = data.count === 0;
      })
      .catch(function () { /* 網路暫時不通就等下一輪 */ });
  }
  setInterval(refresh, 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
