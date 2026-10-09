// 填寫頁的儲存行為：
// 1. 就地儲存：按「儲存」不再整頁重新載入（原本會跳回頁面最上面，而且其他列還沒存的輸入會被丟掉），
//    改用背景請求送出，頁面位置、其他列的輸入、游標焦點都不動；結果顯示在該列。
// 2. 貼上／拖曳截圖：截圖後直接 Ctrl/Cmd+V 貼進游標所在的那一列（或把圖片拖進該列的貼上區），
//    先顯示「待儲存」預覽，按儲存才上傳。
// 3. 儲存全部：有任何項目還沒儲存時，固定列會出現「儲存全部」（Ctrl/Cmd+S 也是），依序一列一列存、逐列回報，
//    失敗的列保持未儲存並列在固定列裡。「送出審核／標記完成／新增設備」前如果還有沒存的，會先問要不要儲存全部。
// 4. 有「還沒儲存的變更」的列會標示出來，這時要離開頁面瀏覽器會提醒一次。
// 沒有 JavaScript 時，表單仍然照常送出（伺服器會導回該列的位置）。
(function () {
  if (!window.XMLHttpRequest || !window.FormData) return;
  if (!document.querySelector('.checklist-row')) return;

  const MAX_FILES = 10;               // 與伺服器一致：一次儲存最多 10 張
  const MAX_BYTES = 10 * 1024 * 1024; // 每張最多 10MB
  const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;

  const dirty = new Set(); // 有未儲存變更的列（row id）
  let busy = 0;            // 進行中的請求數
  let allRunning = false;  // 「儲存全部」進行中
  let progress = '';       // 「儲存全部」目前的進度文字

  const rowOf = (el) => el.closest('.checklist-row');
  const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });

  // ---------- 訊息 ----------

  function say(row, text, kind) {
    const m = row.querySelector('.row-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'row-msg' + (kind ? ' row-msg--' + kind : '');
    if (row._fade) { clearTimeout(row._fade); row._fade = null; }
    if (kind === 'ok') {
      row._fade = setTimeout(function () { if (m.classList.contains('row-msg--ok')) say(row, '', ''); }, 5000);
    }
    refreshBar();
  }

  let toastTimer = null;
  function toast(text) {
    let t = document.getElementById('entry-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'entry-toast';
      t.className = 'entry-toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }

  // ---------- 未儲存標記 ----------

  function markDirty(row) {
    row._ver = (row._ver || 0) + 1; // 送出之後如果又改了，就不能把這一列當成「已儲存」
    dirty.add(row.id);
    row.classList.add('is-dirty');
    if (!row._saving) say(row, '有未儲存的變更', 'dirty');
    refreshBar();
  }

  function onEdit(evt) {
    const form = evt.target.closest ? evt.target.closest('form.item-form') : null;
    if (form) markDirty(rowOf(form));
  }
  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);

  // ---------- 貼上／拖曳的截圖（待儲存）----------

  const pendingOf = (row) => row._pending || (row._pending = []);

  function renderPending(row) {
    const box = row.querySelector('.paste-pending');
    if (!box) return;
    box.textContent = '';
    pendingOf(row).forEach(function (p) {
      const item = document.createElement('div');
      item.className = 'paste-pending__item';
      const img = document.createElement('img');
      img.src = p.url;
      img.alt = '待儲存的截圖';
      const tag = document.createElement('span');
      tag.className = 'paste-pending__tag';
      tag.textContent = '待儲存';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'paste-pending__remove';
      del.title = '移除這張（還沒上傳）';
      del.textContent = '✕';
      del.addEventListener('click', function () {
        row._pending = pendingOf(row).filter(function (x) { return x !== p; });
        URL.revokeObjectURL(p.url);
        renderPending(row);
        markDirty(row);
      });
      item.appendChild(img);
      item.appendChild(tag);
      item.appendChild(del);
      box.appendChild(item);
    });
  }

  function dropPending(row, sent) {
    row._pending = pendingOf(row).filter(function (p) {
      if (sent.indexOf(p) !== -1) { URL.revokeObjectURL(p.url); return false; }
      return true;
    });
    renderPending(row);
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  let pasteSeq = 0;
  function nameFor(file) {
    // 剪貼簿來的圖片檔名通常是 image.png，沒有意義；改成「貼上截圖-時間.副檔名」，之後也看得出是哪一張
    if (file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) return file.name;
    const d = new Date();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[file.type] || 'png';
    pasteSeq++;
    return '貼上截圖-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + pasteSeq + '.' + ext;
  }

  function addImages(row, files) {
    const fileInput = row.querySelector('input[type=file]');
    let count = (fileInput && fileInput.files ? fileInput.files.length : 0) + pendingOf(row).length;
    const rejected = [];
    let added = 0;
    files.forEach(function (raw) {
      const label = raw.name || '圖片';
      if (/hei[cf]/i.test(raw.type)) { rejected.push('「' + label + '」是 HEIC 格式（請先轉成 JPEG／PNG）'); return; }
      if (!IMAGE_TYPES.test(raw.type)) { rejected.push('「' + label + '」不是支援的圖片格式（JPEG／PNG／WebP／GIF）'); return; }
      if (raw.size > MAX_BYTES) { rejected.push('「' + label + '」超過 10MB'); return; }
      if (count >= MAX_FILES) { rejected.push('「' + label + '」（一次最多 ' + MAX_FILES + ' 張，請先儲存再繼續）'); return; }
      const file = new File([raw], nameFor(raw), { type: raw.type });
      pendingOf(row).push({ file: file, url: URL.createObjectURL(file) });
      count++;
      added++;
    });
    renderPending(row);
    if (added) markDirty(row);
    if (rejected.length) say(row, '未加入：' + rejected.join('、'), 'warn'); // 只是提醒，不算儲存失敗
  }

  document.addEventListener('paste', function (evt) {
    const cd = evt.clipboardData;
    if (!cd || !cd.items) return;
    const images = [];
    Array.prototype.forEach.call(cd.items, function (it) {
      if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
        const f = it.getAsFile();
        if (f) images.push(f);
      }
    });
    if (images.length === 0) return; // 沒有圖片：一律照瀏覽器預設（貼文字等）
    const target = evt.target;
    const row = target && target.closest ? rowOf(target) : null;
    const isTextField = target && (target.tagName === 'TEXTAREA' ||
      (target.tagName === 'INPUT' && ['file', 'checkbox', 'radio', 'button', 'submit'].indexOf(target.type) === -1));
    const hasText = Array.prototype.indexOf.call(cd.types || [], 'text/plain') !== -1;
    // 在輸入文字的欄位、而且剪貼簿同時有文字（例如從 Word／Excel 複製）：照常貼文字，不攔截
    if (isTextField && hasText) return;
    if (!row) {
      if (!(target && target.closest && target.closest('#asset-picker'))) {
        toast('要貼上截圖，請先點選那個檢查項目（點它的貼上區或任何欄位），再按 Ctrl/Cmd+V。');
      }
      return;
    }
    evt.preventDefault();
    addImages(row, images);
  });

  // 拖曳：貼上區接收圖片檔；拖到頁面其他地方時擋掉瀏覽器預設的「直接開啟圖片」（原生的選擇檔案欄位照常可以拖進去）
  const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  const inFileInput = (e) => e.target.closest && e.target.closest('input[type=file]');
  document.addEventListener('dragover', function (evt) {
    if (!hasFiles(evt) || inFileInput(evt)) return;
    evt.preventDefault();
    const zone = evt.target.closest && evt.target.closest('.paste-zone');
    document.querySelectorAll('.paste-zone.is-over').forEach(function (z) { if (z !== zone) z.classList.remove('is-over'); });
    if (zone) zone.classList.add('is-over');
  });
  document.addEventListener('dragleave', function (evt) {
    const zone = evt.target.closest && evt.target.closest('.paste-zone');
    if (zone && !zone.contains(evt.relatedTarget)) zone.classList.remove('is-over');
  });
  document.addEventListener('drop', function (evt) {
    if (!hasFiles(evt) || inFileInput(evt)) return;
    evt.preventDefault();
    document.querySelectorAll('.paste-zone.is-over').forEach(function (z) { z.classList.remove('is-over'); });
    const zone = evt.target.closest && evt.target.closest('.paste-zone');
    const row = zone ? rowOf(zone) : null;
    if (row) addImages(row, Array.prototype.slice.call(evt.dataTransfer.files));
  });

  // ---------- 就地更新這一列 ----------

  function applyRow(row, data, opts) {
    const title = row.querySelector('.checklist-row__title');
    let badge = title.querySelector('.status-badge');
    if (!badge) { badge = document.createElement('span'); title.appendChild(badge); }
    badge.className = 'status-badge status-badge--' + data.status;
    badge.textContent = data.statusLabel;
    // 縮圖區與刪除用表單由伺服器用同一份範本渲染，直接換上去，檢視區（photo-viewer.js）用事件代理，不用重新綁定
    row.querySelector('.photo-thumbs').innerHTML = data.thumbsHtml;
    row.querySelector('.photo-delete-forms').innerHTML = data.deleteFormsHtml;
    if (opts.clearFile) {
      const f = row.querySelector('input[type=file]');
      if (f) f.value = '';
    }
  }

  function parse(xhr) {
    try { return JSON.parse(xhr.responseText); } catch (e) { return null; }
  }

  function request(url, body, opts) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    if (opts.contentType) xhr.setRequestHeader('Content-Type', opts.contentType);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.timeout = 5 * 60 * 1000;
    if (opts.onProgress && xhr.upload) xhr.upload.onprogress = opts.onProgress;
    xhr.onload = function () { opts.done(xhr, parse(xhr)); };
    xhr.onerror = function () { opts.fail('網路連線中斷，你輸入的內容還在，請檢查網路後再按一次。'); };
    xhr.ontimeout = function () { opts.fail('處理逾時，請再按一次（圖片很大或網路較慢時可能需要多等一下）。'); };
    xhr.send(body);
  }

  // 儲存一列。回傳 Promise<boolean>：true = 這一列完全儲存成功
  function save(form) {
    return new Promise(function (resolve) {
      const row = rowOf(form);
      if (row._saving) { resolve(false); return; }
      const btn = form.querySelector('button[type=submit]');
      const fileInput = form.querySelector('input[type=file]');
      const sent = pendingOf(row).slice(); // 這一次要送出的貼上圖片
      const fd = new FormData(form);
      sent.forEach(function (p) { fd.append('screenshots', p.file, p.file.name); });
      const hasFiles = sent.length > 0 || !!(fileInput && fileInput.files && fileInput.files.length > 0);
      const sentVer = row._ver || 0;
      row._saving = true;
      busy++;
      btn.disabled = true;
      say(row, hasFiles ? '上傳中 0%' : '儲存中…', 'busy');

      const finish = function () { row._saving = false; busy--; btn.disabled = false; };

      request(form.action, fd, {
        onProgress: hasFiles ? function (e) {
          if (e.lengthComputable) say(row, e.loaded >= e.total ? '處理圖片中…' : '上傳中 ' + Math.round((e.loaded / e.total) * 100) + '%', 'busy');
        } : null,
        done: function (xhr, data) {
          finish();
          const okStatus = xhr.status >= 200 && xhr.status < 300;
          if (okStatus && data && data.ok) {
            applyRow(row, data, { clearFile: true });
            dropPending(row, sent);
            if ((row._ver || 0) === sentVer) {
              dirty.delete(row.id);
              row.classList.remove('is-dirty');
              say(row, '已儲存 ✓', 'ok');
            } else {
              say(row, '已儲存，但之後又有新的變更', 'dirty');
            }
            resolve(true);
          } else if (data && data.savedPartial && data.thumbsHtml) {
            // 文字欄位與沒問題的截圖已經存了，只有某幾張圖片失敗：照實更新這一列並說明原因
            applyRow(row, data, { clearFile: true });
            dropPending(row, sent);
            if ((row._ver || 0) === sentVer) { dirty.delete(row.id); row.classList.remove('is-dirty'); }
            say(row, '其他內容已儲存。' + data.error, 'err');
            resolve(false);
          } else {
            say(row, (data && data.error) || ('儲存失敗（HTTP ' + xhr.status + '），請重新整理頁面後再試。'), 'err');
            resolve(false);
          }
        },
        fail: function (text) { finish(); say(row, text, 'err'); resolve(false); },
      });
    });
  }

  function removePhoto(form) {
    const row = rowOf(form);
    busy++;
    say(row, '刪除中…', 'busy');
    // 刪除表單沒有檔案：用一般表單編碼（urlencoded）送出。CSRF 驗證在處理 multipart 之前就要讀 token，
    // multipart 的內容那時還讀不到（儲存表單的網址上有 ?_csrf=，所以不受影響）。
    request(form.action, new URLSearchParams(new FormData(form)).toString(), {
      contentType: 'application/x-www-form-urlencoded',
      done: function (xhr, data) {
        busy--;
        if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
          applyRow(row, data, { clearFile: false }); // 刪截圖不該動到使用者正準備上傳的檔案與還沒存的文字
          say(row, dirty.has(row.id) ? '已刪除截圖（這一列其他內容還沒儲存）' : '已刪除 ✓', dirty.has(row.id) ? 'dirty' : 'ok');
        } else {
          say(row, (data && data.error) || ('刪除失敗（HTTP ' + xhr.status + '），請重新整理頁面後再試。'), 'err');
        }
      },
      fail: function (text) { busy--; say(row, text, 'err'); },
    });
  }

  // ---------- 儲存全部 ----------

  const bar = document.getElementById('saveall-bar');
  const barText = document.getElementById('saveall-text');
  const barBtn = document.getElementById('saveall-btn');
  const barErrors = document.getElementById('saveall-errors');

  function failedRows() {
    return Array.prototype.slice.call(document.querySelectorAll('.checklist-row .row-msg--err')).map(rowOf);
  }

  function rowName(row) {
    const sec = row.closest('section');
    const asset = sec && sec.querySelector('h2') ? sec.querySelector('h2').textContent : '';
    return (asset ? asset + '・' : '') + row.querySelector('strong').textContent;
  }

  function refreshBar() {
    if (!bar) return;
    const failed = failedRows();
    const show = dirty.size > 0 || allRunning || failed.length > 0;
    bar.hidden = !show;
    if (!show) return;
    barText.textContent = (allRunning && progress) ||
      (dirty.size > 0 ? '有 ' + dirty.size + ' 個項目尚未儲存' + (failed.length ? '（其中 ' + failed.length + ' 個儲存失敗）' : '')
        : '有 ' + failed.length + ' 個項目儲存失敗，請處理');
    barBtn.disabled = allRunning || dirty.size === 0;
    barBtn.textContent = allRunning ? '儲存中…' : (dirty.size > 0 ? '儲存全部（' + dirty.size + '）' : '儲存全部');
    barErrors.textContent = '';
    barErrors.hidden = failed.length === 0 || allRunning;
    if (!barErrors.hidden) {
      failed.forEach(function (row) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = '#' + row.id;
        a.textContent = rowName(row);
        li.appendChild(a);
        li.appendChild(document.createTextNode('：' + row.querySelector('.row-msg').textContent));
        barErrors.appendChild(li);
      });
    }
  }

  async function waitIdle(row) {
    for (let i = 0; i < 600 && row._saving; i++) await sleep(200);
  }

  // 依畫面順序，一列一列儲存。回傳 true = 全部成功
  async function saveAll() {
    if (allRunning) return false;
    allRunning = true;
    const rows = Array.from(dirty).map(function (id) { return document.getElementById(id); })
      .filter(Boolean)
      .sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
    let allOk = true;
    for (let i = 0; i < rows.length; i++) {
      progress = '儲存中 ' + (i + 1) + ' / ' + rows.length + '…';
      refreshBar();
      await waitIdle(rows[i]); // 如果這一列剛好正在單獨儲存，等它完成
      if (!dirty.has(rows[i].id)) continue; // 單獨儲存已經存好了
      const ok = await save(rows[i].querySelector('form.item-form'));
      if (!ok) allOk = false;
    }
    allRunning = false;
    progress = '';
    refreshBar();
    return allOk;
  }

  if (barBtn) barBtn.addEventListener('click', function () { saveAll(); });

  document.addEventListener('keydown', function (evt) {
    if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey && (evt.key === 's' || evt.key === 'S')) {
      evt.preventDefault(); // 取代瀏覽器預設的「另存網頁」
      if (dirty.size > 0) saveAll(); else toast('目前沒有需要儲存的變更。');
    }
  });

  // ---------- 表單送出 ----------

  document.addEventListener('submit', function (evt) {
    const form = evt.target;
    if (!form || !form.matches) return;
    if (form.matches('form.item-form')) {
      evt.preventDefault();
      save(form);
    } else if (form.matches('form[id^="photo-delete-"]')) {
      // 這支腳本比 confirm.js 先註冊：自己問一次確認，並擋住 confirm.js 再問第二次
      evt.preventDefault();
      evt.stopImmediatePropagation();
      const message = form.dataset.confirm;
      if (message && !window.confirm(message)) return;
      removePhoto(form);
    } else if (form.matches('form[action$="/submit"], form[action$="/complete"], form[action$="/assets"]')) {
      // 送出審核／標記完成／新增設備都會離開（或重新載入）這一頁：如果還有沒儲存的項目，先問要不要儲存全部，避免漏資料
      if (dirty.size === 0 && busy === 0 && !allRunning) return;
      evt.preventDefault();
      evt.stopImmediatePropagation();
      if (dirty.size === 0) { window.alert('還有儲存正在進行中，請稍等一下再按。'); return; }
      if (!window.confirm('還有 ' + dirty.size + ' 個項目沒有儲存。\n要先全部儲存再繼續嗎？\n（按「取消」可以留在這一頁再檢查）')) return;
      saveAll().then(function (ok) {
        if (ok) form.requestSubmit(); // 重新送出：這時沒有未儲存的項目了，會照原本流程（例如再確認一次「送出審核」）
        else window.alert('有項目儲存失敗，請先處理畫面上標示的項目（固定列裡有清單），再重新操作。');
      });
    }
  });

  window.addEventListener('beforeunload', function (evt) {
    if (dirty.size > 0 || busy > 0) {
      evt.preventDefault();
      evt.returnValue = '';
    }
  });

  refreshBar();
})();
