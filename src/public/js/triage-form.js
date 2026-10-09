// 處理建議表單：選「持續觀察」「排程處理」才顯示日期；「已處理」要寫原因
(function () {
  const form = document.getElementById('triage-form');
  if (!form) return;
  const box = document.getElementById('triage-date');
  const date = document.getElementById('review_date');
  const label = document.getElementById('triage-date-label');
  const hint = document.getElementById('triage-date-hint');
  const req = document.getElementById('triage-note-req');
  const note = document.getElementById('note');
  function refresh() {
    const sel = form.querySelector('input[name=disposition]:checked');
    const v = sel ? sel.value : '';
    const needsDate = v === 'observe' || v === 'scheduled';
    box.hidden = !needsDate;
    date.required = needsDate;
    if (needsDate) {
      label.textContent = v === 'observe' ? '複查日期' : '預計處理日期';
      hint.textContent = v === 'observe' ? '到這一天還沒恢復，會自動回到「未分流」提醒你再看一次；預設 30 天後，可以自己改。' : '預計處理的日期；過了這一天還沒處理，會自動回到「未分流」。';
      if (!date.value && v === 'observe') date.value = date.dataset.default;
    }
    note.required = v === 'resolved';
    req.textContent = v === 'resolved' ? '（必填）' : '（選填）';
  }
  form.addEventListener('change', refresh);
  refresh();
})();
