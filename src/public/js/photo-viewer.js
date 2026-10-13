// 巡檢截圖／附件圖片檢視：點縮圖／「查看」就地展開檢視區，不開新視窗、也不是蓋住整頁的遮罩
// （做法比照 expense-platform 的憑證檢視：新視窗常被瀏覽器的快顯封鎖擋下，就地展開不受影響）。
// 檢視區功能：
// - 縮放：＋／－按鈕、Ctrl(⌘)＋滾輪（觸控板雙指捏合在 Chrome 也是 ctrlKey 的 wheel）、手機雙指捏合、
//   雙擊／雙點放大（再雙擊還原）；縮放時固定住游標／手指所在的那個點。放大後可拖曳平移。1 倍～6 倍。
// - 向左／向右旋轉（手機拍的照片方向沒轉正時自己轉正，只影響畫面、不改檔案）、還原、
//   上一張／下一張（同一個檢查項目有多張時）、收合；再點同一張縮圖也會收合。
// - 鍵盤：Esc 收合、←→ 換張、＋／－ 縮放、0 還原。
// 沒有 JavaScript 時連結仍可直接開圖。
// 座標一律用「相對於舞台中心」的位置計算（圖片就置中在舞台裡），所以縮放後不會跑位。
// 舞台設 touch-action: none 讓瀏覽器不搶走雙指與拖曳手勢，代價是手指放在圖片上無法捲動頁面——
// 工具列與舞台上下的空白處仍可正常捲動；一般滾輪（沒按 Ctrl/⌘）也照常捲頁面，不會被圖片吃掉。
//
// 用法：<a href="圖片網址" data-viewer="檢視區元素id" data-label="說明文字">…</a>
// 同一個 data-viewer 的連結視為同一組；檢視區元素若在 <tr> 裡，展開/收合時整列一起顯示/隱藏。
(function () {
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  const BUTTON_STEP = 1.4;
  const DOUBLE_TAP_SCALE = 2.5;
  const DOUBLE_TAP_MS = 300;
  const TAP_MOVE_TOLERANCE = 6;
  const clamp = function (v, min, max) { return Math.min(max, Math.max(min, v)); };

  function groupLinks(hostId) {
    return Array.prototype.slice.call(document.querySelectorAll('a[data-viewer="' + hostId + '"]'));
  }

  function container(host) {
    return host.closest('tr') || host;
  }

  function button(text, onClick, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'photo-viewer__btn';
    b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function collapse(host) {
    const state = host._viewer;
    if (state) {
      if (state.cleanup) state.cleanup();
      groupLinks(host.id).forEach(function (a) { a.classList.remove('is-viewing'); });
    }
    host.textContent = '';
    host._viewer = null;
    container(host).hidden = true;
  }

  function show(host, index) {
    const links = groupLinks(host.id);
    const link = links[index];
    if (!link) return;
    if (host._viewer && host._viewer.cleanup) host._viewer.cleanup();
    const state = { index: index, rotation: 0, view: { scale: 1, x: 0, y: 0 }, zoomIn: null, zoomOut: null, reset: null };
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
    img.draggable = false;
    img.hidden = true;
    img.addEventListener('load', function () { msg.hidden = true; img.hidden = false; });
    img.addEventListener('error', function () {
      msg.hidden = false;
      msg.textContent = '圖片載入失敗（可能是登入已逾時，請重新整理頁面後再試）';
    });
    img.src = link.href;

    const zoomLabel = document.createElement('span');
    zoomLabel.className = 'photo-viewer__zoom';

    function applyTransform() {
      const v = state.view;
      img.style.transform = 'translate(' + v.x + 'px, ' + v.y + 'px) scale(' + v.scale + ') rotate(' + state.rotation + 'deg)';
      zoomLabel.textContent = Math.round(v.scale * 100) + '%';
      if (state.minus) state.minus.disabled = v.scale <= MIN_SCALE;
      if (state.plus) state.plus.disabled = v.scale >= MAX_SCALE;
      stage.classList.toggle('is-zoomed', v.scale > MIN_SCALE);
    }
    function setView(v) { state.view = v; applyTransform(); }

    function toLocal(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
    }

    // 以 p 點為不動點，從 base 狀態縮放到 nextScale；縮回 1 倍就歸位，避免圖片停在偏掉的位置
    function zoomAround(nextScale, p, base) {
      base = base || state.view;
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (scale <= MIN_SCALE) { setView({ scale: MIN_SCALE, x: 0, y: 0 }); return; }
      const rect = stage.getBoundingClientRect();
      const k = scale / base.scale;
      const limitX = (rect.width * scale) / 2;
      const limitY = (rect.height * scale) / 2;
      setView({
        scale: scale,
        x: clamp(p.x - k * (p.x - base.x), -limitX, limitX),
        y: clamp(p.y - k * (p.y - base.y), -limitY, limitY),
      });
    }
    const CENTER = { x: 0, y: 0 };
    state.zoomIn = function () { zoomAround(state.view.scale * BUTTON_STEP, CENTER); };
    state.zoomOut = function () { zoomAround(state.view.scale / BUTTON_STEP, CENTER); };
    state.reset = function () { state.rotation = 0; setView({ scale: 1, x: 0, y: 0 }); };

    function rotate(delta) {
      state.rotation += delta;
      applyTransform();
    }

    // ---- 手勢（滑鼠與觸控共用 pointer events）----
    const pointers = new Map();
    let gesture = null;
    const tap = { downAt: 0, moved: false, lastTapAt: 0, lastX: 0, lastY: 0 };

    function startPan(x, y) { gesture = { type: 'pan', startX: x, startY: y, base: state.view }; }

    stage.addEventListener('pointerdown', function (e) {
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件等沒有作用中的指標，忽略 */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.classList.add('is-interacting');
      if (pointers.size === 1) {
        startPan(e.clientX, e.clientY);
        tap.downAt = Date.now();
        tap.moved = false;
      } else if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        gesture = {
          type: 'pinch',
          d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
          m0: toLocal((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2),
          base: state.view,
        };
        tap.moved = true;
      }
    });

    stage.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture;
      if (!g) return;
      const rect = stage.getBoundingClientRect();
      if (g.type === 'pan' && pointers.size === 1) {
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;
        if (Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) tap.moved = true;
        if (g.base.scale <= MIN_SCALE) return;
        const limitX = (rect.width * g.base.scale) / 2;
        const limitY = (rect.height * g.base.scale) / 2;
        setView({ scale: g.base.scale, x: clamp(g.base.x + dx, -limitX, limitX), y: clamp(g.base.y + dy, -limitY, limitY) });
      } else if (g.type === 'pinch' && pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const m = toLocal((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        const scale = clamp(g.base.scale * (d / g.d0), MIN_SCALE, MAX_SCALE);
        if (scale <= MIN_SCALE) { setView({ scale: MIN_SCALE, x: 0, y: 0 }); return; }
        const k = scale / g.base.scale;
        const limitX = (rect.width * scale) / 2;
        const limitY = (rect.height * scale) / 2;
        setView({
          scale: scale,
          x: clamp(m.x - k * (g.m0.x - g.base.x), -limitX, limitX),
          y: clamp(m.y - k * (g.m0.y - g.base.y), -limitY, limitY),
        });
      }
    });

    function pointerUp(e) {
      if (!pointers.delete(e.pointerId)) return;
      const remaining = Array.from(pointers.values());
      if (remaining.length === 1) { startPan(remaining[0].x, remaining[0].y); return; } // 雙指放開一指：剩下那指接著拖曳
      gesture = null;
      stage.classList.remove('is-interacting');
      const now = Date.now();
      if (tap.moved || now - tap.downAt > DOUBLE_TAP_MS) return;
      const nearLast = Math.hypot(e.clientX - tap.lastX, e.clientY - tap.lastY) < 30;
      if (now - tap.lastTapAt < DOUBLE_TAP_MS && nearLast) {
        tap.lastTapAt = 0;
        if (state.view.scale > MIN_SCALE) setView({ scale: MIN_SCALE, x: 0, y: 0 });
        else zoomAround(DOUBLE_TAP_SCALE, toLocal(e.clientX, e.clientY));
      } else {
        tap.lastTapAt = now;
        tap.lastX = e.clientX;
        tap.lastY = e.clientY;
      }
    }
    stage.addEventListener('pointerup', pointerUp);
    stage.addEventListener('pointercancel', pointerUp);

    // 只在按著 Ctrl/⌘ 時才縮放；一般滾輪照常捲頁面。要擋掉瀏覽器自己的頁面縮放必須 passive:false
    function onWheel(e) {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAround(state.view.scale * Math.exp(-clamp(e.deltaY, -50, 50) * 0.005), toLocal(e.clientX, e.clientY));
    }
    stage.addEventListener('wheel', onWheel, { passive: false });
    state.cleanup = function () { stage.removeEventListener('wheel', onWheel); };

    // ---- 工具列 ----
    if (links.length > 1) {
      actions.appendChild(button('‹ 上一張', function () { show(host, (index - 1 + links.length) % links.length); }));
      actions.appendChild(button('下一張 ›', function () { show(host, (index + 1) % links.length); }));
    }
    state.minus = button('－', state.zoomOut, '縮小');
    state.plus = button('＋', state.zoomIn, '放大');
    actions.appendChild(state.minus);
    actions.appendChild(zoomLabel);
    actions.appendChild(state.plus);
    actions.appendChild(button('↺ 向左旋轉', function () { rotate(-90); }));
    actions.appendChild(button('↻ 向右旋轉', function () { rotate(90); }));
    actions.appendChild(button('還原', state.reset));
    actions.appendChild(button('收合', function () { collapse(host); }));

    const hint = document.createElement('p');
    hint.className = 'photo-viewer__hint';
    hint.textContent = '縮放：＋／－按鈕、Ctrl(⌘)＋滾輪、雙指捏合，或雙擊；放大後可拖曳移動。';

    bar.appendChild(title);
    bar.appendChild(actions);
    stage.appendChild(msg);
    stage.appendChild(img);
    panel.appendChild(bar);
    panel.appendChild(stage);
    panel.appendChild(hint);
    host.appendChild(panel);
    applyTransform();

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
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    const open = Array.prototype.slice.call(document.querySelectorAll('[data-viewer-host]')).filter(function (h) { return h._viewer; });
    if (open.length === 0) return;
    const host = open[open.length - 1];
    if (evt.key === 'Escape') {
      open.forEach(collapse);
    } else if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
      const n = groupLinks(host.id).length;
      if (n > 1) {
        const delta = evt.key === 'ArrowRight' ? 1 : -1;
        show(host, (host._viewer.index + delta + n) % n);
      }
    } else if (evt.key === '+' || evt.key === '=') {
      host._viewer.zoomIn();
    } else if (evt.key === '-' || evt.key === '_') {
      host._viewer.zoomOut();
    } else if (evt.key === '0') {
      host._viewer.reset();
    }
  });
})();
