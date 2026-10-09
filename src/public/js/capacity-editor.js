// 填寫頁容量型項目（磁碟空間）的磁碟區編輯：新增／移除列、即時算總容量與使用率、依門檻顯示「建議狀態」（只是建議，要按「套用」才會改）。
// 用事件代理綁在 document 上：就地儲存之後伺服器會把編輯區整塊換掉，不用重新綁定。
(function () {
  const UNITS = { M: 1 / 1024, MB: 1 / 1024, G: 1, GB: 1, T: 1024, TB: 1024 };

  function parseSize(text) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(MB|GB|TB|M|G|T)?\s*$/i.exec(String(text || '').replace(/,/g, ''));
    return m ? Number(m[1]) * (m[2] ? UNITS[m[2].toUpperCase()] : 1) : null;
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  const STATUS = { normal: '正常', warning: '警告', critical: '異常' };

  function rowValues(row) {
    const used = parseSize(row.querySelector('[name=vol_used]').value);
    const freeText = row.querySelector('[name=vol_free]').value.trim();
    let total = null;
    if (used != null) {
      if (freeText) {
        const free = parseSize(freeText);
        if (free != null) total = used + free;
      } else {
        const hint = parseSize(row.querySelector('[name=vol_total]').value);
        if (hint != null && used <= hint) total = hint; // 只填已用：用上次的總容量推算剩餘
      }
    }
    return { used: used, total: total };
  }

  function refresh(editor) {
    const warn = Number(editor.dataset.warn) || 85;
    const crit = Number(editor.dataset.crit) || 95;
    let max = null;
    editor.querySelectorAll('.vol-row').forEach(function (row) {
      const v = rowValues(row);
      const calc = row.querySelector('.vol-row__calc');
      if (v.used != null && v.total != null && v.total > 0) {
        const p = (v.used / v.total) * 100;
        calc.textContent = '總容量 ' + fmt(v.total) + ' GB・使用率 ' + (Math.round(p * 10) / 10).toFixed(1) + '%';
        calc.className = 'vol-row__calc' + (p >= crit ? ' is-critical' : (p >= warn ? ' is-warning' : ''));
        if (max == null || p > max) max = p;
      } else {
        calc.textContent = '';
        calc.className = 'vol-row__calc';
      }
    });
    const box = editor.querySelector('.vol-editor__suggest');
    const form = editor.closest('form');
    const select = form && form.querySelector('select[name=status]');
    if (max == null || !select) { box.textContent = ''; return; }
    const suggested = max >= crit ? 'critical' : (max >= warn ? 'warning' : 'normal');
    if (select.value === suggested) {
      box.textContent = '最高使用率 ' + (Math.round(max * 10) / 10).toFixed(1) + '%，狀態與建議一致';
      return;
    }
    box.textContent = '最高使用率 ' + (Math.round(max * 10) / 10).toFixed(1) + '%，建議狀態：' + STATUS[suggested] + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn--secondary btn--sm vol-editor__apply';
    btn.dataset.status = suggested;
    btn.textContent = '套用「' + STATUS[suggested] + '」';
    box.appendChild(btn);
  }

  function notify(form) { form.dispatchEvent(new Event('input', { bubbles: true })); } // 讓 entry-save.js 把這一列標成「有未儲存的變更」

  document.addEventListener('input', function (e) {
    const editor = e.target.closest && e.target.closest('.vol-editor');
    if (editor) refresh(editor);
  });
  document.addEventListener('change', function (e) {
    if (e.target.name === 'status') {
      const form = e.target.closest('form.item-form');
      const editor = form && form.querySelector('.vol-editor');
      if (editor) refresh(editor);
    }
  });

  document.addEventListener('click', function (e) {
    const add = e.target.closest('.vol-editor__add');
    if (add) {
      const editor = add.closest('.vol-editor');
      const rows = editor.querySelector('.vol-editor__rows');
      const tpl = rows.querySelector('.vol-row');
      const row = tpl ? tpl.cloneNode(true) : null;
      if (!row) return;
      row.querySelectorAll('input').forEach(function (i) { i.value = ''; });
      row.querySelectorAll('input[name=vol_used]').forEach(function (i) { i.placeholder = '已用'; });
      rows.appendChild(row);
      row.querySelector('[name=vol_name]').focus();
      refresh(editor);
      notify(editor.closest('form'));
      return;
    }
    const rem = e.target.closest('.vol-row__remove');
    if (rem) {
      const editor = rem.closest('.vol-editor');
      const rows = editor.querySelector('.vol-editor__rows');
      const row = rem.closest('.vol-row');
      if (rows.querySelectorAll('.vol-row').length > 1) row.remove();
      else row.querySelectorAll('input:not([type=hidden])').forEach(function (i) { i.value = ''; }); // 最後一列：清空（存檔後就是沒有磁碟區）
      refresh(editor);
      notify(editor.closest('form'));
      return;
    }
    const apply = e.target.closest('.vol-editor__apply');
    if (apply) {
      const editor = apply.closest('.vol-editor'); // 先取得：change 事件會重畫建議區、把這顆按鈕換掉
      const form = apply.closest('form.item-form');
      const select = form.querySelector('select[name=status]');
      select.value = apply.dataset.status;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refresh(editor);
    }
  });

  document.addEventListener('capacity:refresh', function (e) {
    e.detail.querySelectorAll('.vol-editor').forEach(refresh);
  });

  document.querySelectorAll('.vol-editor').forEach(refresh);
})();
