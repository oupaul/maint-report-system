// 填寫頁的「就地儲存」：按「儲存」不再整頁重新載入（原本會跳回頁面最上面，而且其他列還沒存的輸入會被丟掉），
// 改用背景請求送出，頁面位置、其他列的輸入、游標焦點都不動；結果顯示在該列。
// - 儲存中顯示進度（上傳大圖時是百分比），按鈕停用，避免連點造成重複上傳。
// - 儲存後當場更新狀態標籤與截圖縮圖；刪除截圖也是就地刪除。
// - 任何一列有「還沒儲存的變更」都會標示出來，這時要離開頁面瀏覽器會提醒一次。
// - 沒有 JavaScript 時，表單仍然照常送出（伺服器會導回該列的位置）。
(function () {
  if (!window.XMLHttpRequest || !window.FormData) return;
  if (!document.querySelector('.checklist-row')) return;

  const dirty = new Set(); // 有未儲存變更的列（row id）
  let busy = 0;            // 進行中的請求數

  const rowOf = (el) => el.closest('.checklist-row');

  function say(row, text, kind) {
    const m = row.querySelector('.row-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'row-msg' + (kind ? ' row-msg--' + kind : '');
    if (row._fade) { clearTimeout(row._fade); row._fade = null; }
    if (kind === 'ok') {
      row._fade = setTimeout(function () { if (m.classList.contains('row-msg--ok')) say(row, '', ''); }, 5000);
    }
  }

  function markDirty(row) {
    row._ver = (row._ver || 0) + 1; // 送出之後如果又改了，就不能把這一列當成「已儲存」
    dirty.add(row.id);
    row.classList.add('is-dirty');
    if (!row._saving) say(row, '有未儲存的變更', 'dirty');
  }

  function onEdit(evt) {
    const form = evt.target.closest ? evt.target.closest('form.item-form') : null;
    if (form) markDirty(rowOf(form));
  }
  document.addEventListener('input', onEdit);
  document.addEventListener('change', onEdit);

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

  function save(form) {
    const row = rowOf(form);
    if (row._saving) return;
    const btn = form.querySelector('button[type=submit]');
    const fileInput = form.querySelector('input[type=file]');
    const hasFiles = !!(fileInput && fileInput.files && fileInput.files.length > 0);
    const sentVer = row._ver || 0;
    row._saving = true;
    busy++;
    btn.disabled = true;
    say(row, hasFiles ? '上傳中 0%' : '儲存中…', 'busy');

    const finish = function () { row._saving = false; busy--; btn.disabled = false; };

    request(form.action, new FormData(form), {
      onProgress: hasFiles ? function (e) {
        if (e.lengthComputable) say(row, e.loaded >= e.total ? '處理圖片中…' : '上傳中 ' + Math.round((e.loaded / e.total) * 100) + '%', 'busy');
      } : null,
      done: function (xhr, data) {
        finish();
        const okStatus = xhr.status >= 200 && xhr.status < 300;
        if (okStatus && data && data.ok) {
          applyRow(row, data, { clearFile: true });
          if ((row._ver || 0) === sentVer) {
            dirty.delete(row.id);
            row.classList.remove('is-dirty');
            say(row, '已儲存 ✓', 'ok');
          } else {
            say(row, '已儲存，但之後又有新的變更', 'dirty');
          }
        } else if (data && data.savedPartial && data.thumbsHtml) {
          // 文字欄位與部分截圖已經存了，只有某張圖片失敗：照實更新這一列並說明原因
          applyRow(row, data, { clearFile: true });
          if ((row._ver || 0) === sentVer) { dirty.delete(row.id); row.classList.remove('is-dirty'); }
          say(row, '其他內容已儲存，但' + data.error, 'err');
        } else {
          say(row, (data && data.error) || ('儲存失敗（HTTP ' + xhr.status + '），請重新整理頁面後再試。'), 'err');
        }
      },
      fail: function (text) { finish(); say(row, text, 'err'); },
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
    }
  });

  window.addEventListener('beforeunload', function (evt) {
    if (dirty.size > 0 || busy > 0) {
      evt.preventDefault();
      evt.returnValue = '';
    }
  });
})();
