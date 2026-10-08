// 「系統管理」選單是原生 <details>，點開、點收合不需要 JavaScript；
// 這裡只補兩個習慣：點選單外面、或按 Esc 時自動收起來。
(function () {
  const menu = document.querySelector('details.nav-menu');
  if (!menu) return;
  document.addEventListener('click', function (evt) {
    if (menu.open && !menu.contains(evt.target)) menu.open = false;
  });
  document.addEventListener('keydown', function (evt) {
    if (evt.key === 'Escape' && menu.open) {
      menu.open = false;
      const summary = menu.querySelector('summary');
      if (summary) summary.focus();
    }
  });
})();
