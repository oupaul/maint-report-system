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
    if (!canvas || !input) return;

    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1E293B';

    let drawing = false;
    let hasDrawn = false;
    let points = [];

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

    function start(evt) {
      drawing = true;
      hasDrawn = true;
      // 用 pointer capture 讓這根手指/游標即使畫出畫布範圍（觸控板移動常常
      // 不像滑鼠那麼精準，很容易滑出這塊小畫布）也還是持續收得到後續的
      // pointermove／pointerup，不會讓筆畫斷掉、卡在「還在畫」的狀態。
      canvas.setPointerCapture(evt.pointerId);
      points = [pos(evt)];
      evt.preventDefault();
    }

    function move(evt) {
      if (!drawing) return;
      points.push(pos(evt));

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

    function end(evt) {
      if (!drawing) return;
      drawing = false;
      points = [];
      if (evt && canvas.hasPointerCapture && canvas.hasPointerCapture(evt.pointerId)) {
        canvas.releasePointerCapture(evt.pointerId);
      }
    }

    canvas.style.touchAction = 'none'; // 避免觸控畫簽名時同時觸發頁面捲動
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        clearCanvas();
        hasDrawn = false;
        if (typeInput) typeInput.value = '';
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
})();
