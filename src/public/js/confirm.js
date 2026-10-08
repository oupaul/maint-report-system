// 取代 views 裡原本的 onsubmit="return confirm(...)"：CSP 不允許 inline 事件處理器，
// 改成在表單上寫 data-confirm="要問的話"，這裡統一攔截 submit 事件。
document.addEventListener('submit', function (evt) {
  const form = evt.target;
  if (!(form instanceof HTMLFormElement)) return;
  const message = form.dataset.confirm;
  if (message && !window.confirm(message)) {
    evt.preventDefault();
  }
});
