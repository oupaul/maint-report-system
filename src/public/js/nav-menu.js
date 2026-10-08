// 導覽列的下拉選單（系統管理、通知）是原生 <details>，點開、點收合不需要 JavaScript；
// 這裡只補兩個習慣：點選單外面、或按 Esc 時自動收起來，而且同一時間只開一個。
(function () {
  const menus = Array.prototype.slice.call(document.querySelectorAll('details.nav-menu, details.notif-menu'));
  if (menus.length === 0) return;
  document.addEventListener('click', function (evt) {
    menus.forEach(function (m) {
      if (m.open && !m.contains(evt.target)) m.open = false;
    });
  });
  menus.forEach(function (m) {
    m.addEventListener('toggle', function () {
      if (!m.open) return;
      menus.forEach(function (other) { if (other !== m) other.open = false; });
    });
  });
  document.addEventListener('keydown', function (evt) {
    if (evt.key !== 'Escape') return;
    menus.forEach(function (m) {
      if (!m.open) return;
      m.open = false;
      const summary = m.querySelector('summary');
      if (summary) summary.focus();
    });
  });
})();
