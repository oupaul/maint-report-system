// 可搜尋的下拉選單：<select data-searchable> 的選項很多（8 個以上）時，加上一個輸入框，輸入關鍵字即時過濾。
// 原本的 <select> 還在（視覺上隱藏），所選的值、表單送出、required 檢查、change 事件都照舊，
// 所以其他頁面程式（選了就自動套用篩選等）完全不用改。選項可以加 data-search 補充搜尋字（例如統編、代碼）。
// 鍵盤：↑↓ 移動、Enter 選取、Esc 取消；多個關鍵字用空白分開（每個都要符合）。
(function () {
  const MIN_OPTIONS = 8;
  let uid = 0;

  function enhance(select) {
    if (select.dataset.csDone || select.multiple || select.options.length < MIN_OPTIONS) return;
    select.dataset.csDone = '1';
    const id = 'cs' + (++uid);

    const opts = Array.prototype.map.call(select.options, function (o) {
      return { value: o.value, label: o.text.trim(), hay: (o.text + ' ' + (o.getAttribute('data-search') || '')).toLowerCase() };
    });

    const wrap = document.createElement('div');
    wrap.className = 'cs';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input cs__input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', id + '-list');
    input.placeholder = '輸入關鍵字搜尋…';
    if (select.getAttribute('aria-label')) input.setAttribute('aria-label', select.getAttribute('aria-label'));
    if (select.id) {
      input.id = select.id + '-cs';
      const label = document.querySelector('label[for="' + select.id + '"]');
      if (label) label.setAttribute('for', input.id);
    }
    const list = document.createElement('ul');
    list.className = 'cs__list';
    list.id = id + '-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;

    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    wrap.appendChild(input);
    wrap.appendChild(list);
    select.classList.add('cs__native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    let shown = [];      // 目前列出的選項
    let active = -1;     // 目前標示的項目
    let typing = false;  // 使用者是否已經開始輸入（還沒輸入時列出全部，方便瀏覽）

    // 選到「空值」的選項（請選擇客戶、全部客戶…）時輸入框留空，那段文字改當灰色提示字，不會變成要使用者刪掉的內容
    const emptyOpt = opts.find(function (o) { return o.value === ''; });
    if (emptyOpt) input.placeholder = emptyOpt.label;
    function currentLabel() {
      if (select.selectedIndex < 0 || select.value === '') return '';
      return select.options[select.selectedIndex].text.trim();
    }

    function render() {
      const tokens = typing ? input.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
      shown = opts.filter(function (o) { return tokens.every(function (t) { return o.hay.indexOf(t) !== -1; }); });
      list.textContent = '';
      if (shown.length === 0) {
        const li = document.createElement('li');
        li.className = 'cs__empty';
        li.textContent = '沒有符合的項目';
        list.appendChild(li);
        active = -1;
        return;
      }
      const cur = select.value;
      active = Math.max(0, shown.findIndex(function (o) { return o.value === cur; }));
      if (typing) active = 0;
      shown.forEach(function (o, i) {
        const li = document.createElement('li');
        li.className = 'cs__opt' + (o.value === cur ? ' is-selected' : '') + (i === active ? ' is-active' : '');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', o.value === cur ? 'true' : 'false');
        li.textContent = o.label;
        li.dataset.i = String(i);
        list.appendChild(li);
      });
      const el = list.querySelector('.is-active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    function open() {
      if (!list.hidden) return;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      render();
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      typing = false;
      input.value = currentLabel();
    }
    function choose(o) {
      const changed = select.value !== o.value;
      select.value = o.value;
      close();
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function move(d) {
      if (shown.length === 0) return;
      active = (active + d + shown.length) % shown.length;
      Array.prototype.forEach.call(list.querySelectorAll('.cs__opt'), function (li, i) { li.classList.toggle('is-active', i === active); });
      const el = list.querySelector('.is-active');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }

    input.value = currentLabel();
    input.addEventListener('focus', function () { input.select(); open(); });
    // 已經有焦點、清單關閉時再點一下：開啟並全選文字，直接輸入就是新的搜尋（延後一拍，等瀏覽器放完游標）
    input.addEventListener('mousedown', function () { input._wasClosed = list.hidden; });
    input.addEventListener('click', function () {
      if (input._wasClosed) { open(); setTimeout(function () { input.select(); }, 0); }
    });
    input.addEventListener('input', function () { typing = true; if (list.hidden) { list.hidden = false; input.setAttribute('aria-expanded', 'true'); } render(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); else move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) open(); else move(-1); }
      else if (e.key === 'Enter') { if (!list.hidden) { e.preventDefault(); if (shown[active]) choose(shown[active]); } }
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); close(); } }
      else if (e.key === 'Tab') { if (!list.hidden) close(); }
    });
    input.addEventListener('blur', function () { if (!list.hidden) close(); });
    // mousedown 先擋掉，輸入框才不會在點選項目之前失焦
    list.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const li = e.target.closest('.cs__opt');
      if (li && shown[Number(li.dataset.i)]) choose(shown[Number(li.dataset.i)]);
    });
    // required 沒選時，瀏覽器要聚焦的是看不見的原生選單，改聚焦輸入框
    // （瀏覽器在 invalid 事件之後才會聚焦原生選單，所以要延後一拍才蓋得過去）
    select.addEventListener('invalid', function () { setTimeout(function () { input.focus(); }, 0); });
    select.addEventListener('change', function () { if (list.hidden) input.value = currentLabel(); });
    if (select.form) select.form.addEventListener('reset', function () { setTimeout(function () { input.value = currentLabel(); }, 0); });
  }

  document.querySelectorAll('select[data-searchable]').forEach(enhance);
})();
