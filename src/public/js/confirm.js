// 取代 views 裡原本的 onsubmit="return confirm(...)"：CSP 不允許 inline 事件處理器，
// 改成在表單上寫 data-confirm="要問的話"，這裡統一攔截 submit 事件。
// 同一個表單有多個送出按鈕、各自需要不同的確認訊息時（例如批次設定客戶 vs 批次刪除），
// 在「按鈕」上寫 data-confirm，會優先於表單上的。
document.addEventListener('submit', function (evt) {
  const form = evt.target;
  if (!(form instanceof HTMLFormElement)) return;
  const submitter = evt.submitter;
  const message = (submitter && submitter.dataset && submitter.dataset.confirm) || form.dataset.confirm;
  if (message && !window.confirm(message)) {
    evt.preventDefault();
  }
});
