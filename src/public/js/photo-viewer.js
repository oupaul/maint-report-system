// 巡檢截圖檢視：點縮圖／「查看」就地展開檢視區，不開新視窗、也不是蓋住整頁的遮罩
// （做法比照 expense-platform 的憑證檢視：新視窗常被瀏覽器的快顯封鎖擋下，就地展開不受影響）。
// 檢視區有檔案說明、向左／向右旋轉（手機拍的照片方向沒轉正時，看的人自己轉正就好，
// 只影響畫面、不改檔案）、上一張／下一張（同一個檢查項目有多張時）、收合；
// 再點同一張縮圖也會收合。沒有 JavaScript 時連結仍可直接開圖。
//
// 用法：<a href="圖片網址" data-viewer="檢視區元素id" data-label="說明文字">…</a>
// 同一個 data-viewer 的連結視為同一組；檢視區元素若在 <tr> 裡，展開/收合時整列一起顯示/隱藏。
(function () {
  function groupLinks(hostId) {
    return Array.prototype.slice.call(document.querySelectorAll('a[data-viewer="' + hostId + '"]'));
  }

  function container(host) {
    return host.closest('tr') || host;
  }

  function button(text, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'photo-viewer__btn';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function collapse(host) {
    const state = host._viewer;
    if (state) groupLinks(host.id).forEach(function (a) { a.classList.remove('is-viewing'); });
    host.textContent = '';
    host._viewer = null;
    container(host).hidden = true;
  }

  function show(host, index) {
    const links = groupLinks(host.id);
    const link = links[index];
    if (!link) return;
    const state = host._viewer || { rotation: 0 };
    state.index = index;
    state.rotation = 0;
    host._viewer = state;

    links.forEach(function (a, i) { a.classList.toggle('is-viewing', i === index); });

    host.textContent = '';
    const panel = document.createElement('div');
    panel.className = 'photo-viewer';

    const bar = document.createElement('div');
    bar.className = 'photo-viewer__bar';
    const title = document.createElement('span');
    title.className = 'photo-viewer__title';
    title.textContent = (link.dataset.label || '截圖') + (links.length > 1 ? '（' + (index + 1) + ' / ' + links.length + '）' : '');
    const actions = document.createElement('div');
    actions.className = 'photo-viewer__actions';

    const stage = document.createElement('div');
    stage.className = 'photo-viewer__stage';
    const msg = document.createElement('div');
    msg.className = 'photo-viewer__msg';
    msg.textContent = '載入中…';
    const img = document.createElement('img');
    img.className = 'photo-viewer__img';
    img.alt = link.dataset.label || '巡檢截圖';
    img.hidden = true;
    img.addEventListener('load', function () { msg.hidden = true; img.hidden = false; });
    img.addEventListener('error', function () {
      msg.hidden = false;
      msg.textContent = '圖片載入失敗（可能是登入已逾時，請重新整理頁面後再試）';
    });
    img.src = link.href;

    function rotate(delta) {
      state.rotation += delta;
      img.style.transform = 'rotate(' + state.rotation + 'deg)';
    }

    if (links.length > 1) {
      actions.appendChild(button('‹ 上一張', function () { show(host, (index - 1 + links.length) % links.length); }));
      actions.appendChild(button('下一張 ›', function () { show(host, (index + 1) % links.length); }));
    }
    actions.appendChild(button('↺ 向左旋轉', function () { rotate(-90); }));
    actions.appendChild(button('↻ 向右旋轉', function () { rotate(90); }));
    actions.appendChild(button('收合', function () { collapse(host); }));

    bar.appendChild(title);
    bar.appendChild(actions);
    stage.appendChild(msg);
    stage.appendChild(img);
    panel.appendChild(bar);
    panel.appendChild(stage);
    host.appendChild(panel);

    const wasHidden = container(host).hidden;
    container(host).hidden = false;
    if (wasHidden && host.scrollIntoView) host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  document.addEventListener('click', function (evt) {
    const link = evt.target.closest ? evt.target.closest('a[data-viewer]') : null;
    if (!link) return;
    const host = document.getElementById(link.dataset.viewer);
    if (!host) return; // 找不到檢視區就維持連結原本的行為
    evt.preventDefault();
    const links = groupLinks(host.id);
    const index = links.indexOf(link);
    // 再點同一張就收合，避免使用者搞不清楚「怎麼點都沒反應」
    if (host._viewer && host._viewer.index === index) {
      collapse(host);
    } else {
      show(host, index);
    }
  });

  document.addEventListener('keydown', function (evt) {
    const tag = evt.target && evt.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const open = Array.prototype.slice.call(document.querySelectorAll('[data-viewer-host]')).filter(function (h) { return h._viewer; });
    if (open.length === 0) return;
    if (evt.key === 'Escape') {
      open.forEach(collapse);
    } else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
      const host = open[open.length - 1];
      const n = groupLinks(host.id).length;
      if (n > 1) {
        const delta = evt.key === 'ArrowRight' ? 1 : -1;
        show(host, (host._viewer.index + delta + n) % n);
      }
    }
  });
})();
