// 導覽列「通知」的未讀數字與系統通知橫幅：頁面開著時每 20 秒悄悄更新一次，不用整頁重新載入
// （管理員發送「系統即將更新」之後，線上的人幾秒內就會看到橫幅；撤回或到期也會自動消失）。
// 只在分頁可見時才查，避免背景分頁白白打請求。
(function () {
  const badge = document.getElementById('notif-badge');
  const bar = document.getElementById('announcements');
  if (!badge && !bar) return;

  // 使用者按「知道了」收起來的橫幅，記在這個瀏覽器（localStorage 不可用就算了，只是下次載入又會出現）
  const KEY = 'dismissedAnnouncements';
  function dismissed() {
    try { return JSON.parse(window.localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
  }
  function remember(id) {
    try {
      const list = dismissed().filter(function (x) { return x !== id; });
      list.push(id);
      window.localStorage.setItem(KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* ignore */ }
  }

  function bind(el) {
    const btn = el.querySelector('.announcement__close');
    if (btn) btn.addEventListener('click', function () { remember(Number(el.dataset.id)); el.remove(); });
  }

  function build(a) {
    const el = document.createElement('div');
    el.className = 'announcement announcement--' + (a.level === 'warning' ? 'warning' : 'info');
    el.dataset.id = String(a.id);
    el.setAttribute('role', 'status');
    const mk = function (tag, cls, text) { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
    el.appendChild(mk('span', 'announcement__tag', a.level === 'warning' ? '重要' : '系統通知'));
    el.appendChild(mk('span', 'announcement__text', a.message)); // textContent：訊息內容一律當純文字，不會被當成 HTML
    el.appendChild(mk('time', 'announcement__time', a.at + ' 發布'));
    const close = mk('button', 'announcement__close', '知道了');
    close.type = 'button';
    el.appendChild(close);
    bind(el);
    return el;
  }

  function syncBanners(list) {
    if (!bar) return;
    const hidden = dismissed();
    const activeIds = {};
    list.forEach(function (a) { activeIds[a.id] = true; });
    Array.prototype.slice.call(bar.querySelectorAll('.announcement')).forEach(function (el) {
      if (!activeIds[el.dataset.id]) el.remove();           // 到期或被撤回
      else if (hidden.indexOf(Number(el.dataset.id)) !== -1) el.remove(); // 這個瀏覽器已經按過「知道了」
    });
    list.slice().reverse().forEach(function (a) {
      if (hidden.indexOf(a.id) !== -1) return;
      if (!bar.querySelector('.announcement[data-id="' + a.id + '"]')) bar.insertBefore(build(a), bar.firstChild);
    });
  }

  // 頁面一載入先把已經按過「知道了」的橫幅收掉，並綁定關閉按鈕
  if (bar) {
    const hidden = dismissed();
    Array.prototype.slice.call(bar.querySelectorAll('.announcement')).forEach(function (el) {
      if (hidden.indexOf(Number(el.dataset.id)) !== -1) el.remove(); else bind(el);
    });
  }

  function refresh() {
    if (document.hidden) return;
    fetch('/notifications/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (badge && typeof data.count === 'number') {
          badge.textContent = String(data.count);
          badge.hidden = data.count === 0;
        }
        if (Array.isArray(data.announcements)) syncBanners(data.announcements);
      })
      .catch(function () { /* 網路暫時不通就等下一輪 */ });
  }
  setInterval(refresh, 20 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
