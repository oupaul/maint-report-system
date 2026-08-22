// 簽名畫布：用 Pointer Events 同時支援滑鼠／觸控／觸控筆，不引入額外套件。
// 每個 form.signature-form 底下需要：canvas.signature-pad、
// input.signature-data-input（hidden）、button.signature-clear（選填）、
// input.signature-type-input（選填，文字輸入的替代簽名方式）。
(function () {
  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function setupPad(form) {
    const canvas = form.querySelector('.signature-pad');
    const input = form.querySelector('.signature-data-input');
    const clearBtn = form.querySelector('.signature-clear');
    const typeInput = form.querySelector('.signature-type-input');
    const fileInput = form.querySelector('.signature-file-input');
    if (!canvas || !input) return;

    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1E293B';

    let drawing = false;
    let hasDrawn = false;
    let points = [];
    let strokeMoved = false;
    const DRAG_THRESHOLD = 4; // canvas 座標空間內的像素，超過這個距離才算「有拖曳」

    function pos(evt) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (evt.clientX - rect.left) * (canvas.width / rect.width),
        y: (evt.clientY - rect.top) * (canvas.height / rect.height),
      };
    }

    function clearCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function beginStroke(evt) {
      drawing = true;
      hasDrawn = true;
      // 用 pointer capture 讓這根手指/游標即使畫出畫布範圍（觸控板移動常常
      // 不像滑鼠那麼精準，很容易滑出這塊小畫布）也還是持續收得到後續的
      // pointermove，不會讓筆畫斷掉、卡在「還在畫」的狀態。
      canvas.setPointerCapture(evt.pointerId);
      points = [pos(evt)];
    }

    function endStroke(evt) {
      drawing = false;
      points = [];
      if (evt && canvas.hasPointerCapture && canvas.hasPointerCapture(evt.pointerId)) {
        canvas.releasePointerCapture(evt.pointerId);
      }
    }

    // 觸控螢幕：手指碰到就開始畫、放開就結束，跟現實中手指畫圖一樣自然，
    // 保留原本「按住拖曳」的邏輯。
    //
    // 滑鼠／觸控板（含筆電觸控板——瀏覽器把觸控板移動視為 pointerType
    // "mouse"，不是 "touch"）：兩種手勢都支援，放開時（見 up()）依有沒有
    // 明顯拖曳來判斷是哪一種——
    //   (a) 按住拖曳：跟以前一樣，放開就收筆，習慣滑鼠拖曳的人不受影響。
    //   (b) 點一下（幾乎沒移動就放開）：當作「落筆」，維持畫筆狀態，游標
    //       移動就畫，不需要整段按著；再點一下（幾乎沒移動）才收筆。這是
    //       給觸控板用的——觸控板要一直維持按壓才能拖曳畫線很不自然。
    function start(evt) {
      if (evt.pointerType !== 'touch' && drawing) {
        // 目前正處於「點一下切換」後的落筆狀態，這次點擊代表收筆。
        endStroke(evt);
        evt.preventDefault();
        return;
      }
      beginStroke(evt);
      strokeMoved = false;
      evt.preventDefault();
    }

    function move(evt) {
      if (!drawing) return;
      const p = pos(evt);

      if (evt.pointerType !== 'touch' && !strokeMoved) {
        const last = points[points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > DRAG_THRESHOLD) strokeMoved = true;
      }

      points.push(p);

      // 用二次貝茲曲線通過相鄰兩點的中點來畫，筆畫比逐點直線連接平滑，
      // 觸控板取樣點通常比滑鼠稀疏、抖動也較明顯，平滑後比較不會看起來鋸齒狀。
      if (points.length > 2) {
        const [p0, p1, p2] = points.slice(-3);
        const start = midpoint(p0, p1);
        const end = midpoint(p1, p2);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(p1.x, p1.y, end.x, end.y);
        ctx.stroke();
      }
      evt.preventDefault();
    }

    function up(evt) {
      if (!drawing) return;
      // 觸控螢幕、或滑鼠/觸控板「有明顯拖曳」：放開就收筆（傳統行為）。
      // 滑鼠/觸控板「幾乎沒動就放開」：當成點一下切換落筆，維持畫筆狀態，
      // 交給下一次點擊（見 start()）收筆，這裡先不結束。
      if (evt.pointerType === 'touch' || strokeMoved) endStroke(evt);
    }

    function cancel(evt) {
      if (drawing) endStroke(evt);
    }

    canvas.style.touchAction = 'none'; // 避免觸控畫簽名時同時觸發頁面捲動
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', cancel);

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        clearCanvas();
        hasDrawn = false;
        if (typeInput) typeInput.value = '';
        if (fileInput) fileInput.value = '';
      });
    }

    // 不方便手寫（例如筆電只有觸控板）時，可以直接輸入姓名，畫布會即時把
    // 文字用手寫風格的字型畫上去，一樣送出同一張 canvas 產生的簽名圖，
    // 後端完全不用區分是手寫還是輸入姓名。
    if (typeInput) {
      typeInput.addEventListener('input', function () {
        clearCanvas();
        const name = typeInput.value.trim();
        if (!name) {
          hasDrawn = false;
          return;
        }
        ctx.font = `italic 44px 'Segoe Script', 'Brush Script MT', cursive, ${getComputedStyle(document.body).fontFamily}`;
        ctx.fillStyle = '#1E293B';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 12, canvas.height / 2, canvas.width - 24);
        hasDrawn = true;
      });
    }

    // 瀏覽器沒有辦法讀取「手指有沒有放在觸控板上但還沒按」這種原始資料
    // （像 Mac 預覽程式/Word 那種以觸控板簽名的功能，用的是作業系統私有
    // API，網頁完全存取不到），所以另外提供「上傳圖檔」——可以先用作業系統
    // 內建的簽名工具（例如 Mac 預覽程式的觸控板簽名）簽好存成圖片，再上傳，
    // 一樣會畫進同一塊畫布、走同一套送出流程。
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        const file = fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (loadEvt) {
          const img = new Image();
          img.onload = function () {
            clearCanvas();
            const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
            const w = img.width * scale;
            const h = img.height * scale;
            ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
            hasDrawn = true;
          };
          img.src = loadEvt.target.result;
        };
        reader.readAsDataURL(file);
      });
    }

    form.addEventListener('submit', function (evt) {
      if (!hasDrawn) {
        evt.preventDefault();
        alert('請先簽名（手寫或輸入姓名）再送出');
        return;
      }
      input.value = canvas.toDataURL('image/png');
    });
  }

  document.querySelectorAll('form.signature-form').forEach(setupPad);

  // 點「簽署」按鈕才跳出簽名視窗（<dialog>），畫完送出後瀏覽器會自然重新
  // 整理頁面，不需要額外處理關閉。<dialog> 是瀏覽器原生元素，內建 modal
  // 行為（含 ESC 關閉），不用額外套件或自己刻遮罩層。
  document.querySelectorAll('.signature-open-btn').forEach(function (btn) {
    const dialog = document.getElementById(btn.dataset.dialog);
    if (!dialog) return;
    btn.addEventListener('click', function () {
      dialog.showModal();
    });
  });

  document.querySelectorAll('.signature-dialog').forEach(function (dialog) {
    const cancelBtn = dialog.querySelector('.signature-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        dialog.close();
      });
    }
    // 點視窗外側的遮罩（backdrop）也可以直接關閉，event.target 只有點在
    // dialog 元素本身（不是裡面的子元素）時才會等於 dialog。
    dialog.addEventListener('click', function (evt) {
      if (evt.target === dialog) dialog.close();
    });
  });
})();
