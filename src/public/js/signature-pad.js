// 簽名畫布：用 Pointer Events 同時支援滑鼠／觸控／觸控筆，不引入額外套件。
// 每個 form.signature-form 底下需要：canvas.signature-pad、
// input.signature-data-input（hidden）、button.signature-clear（選填）。
(function () {
  function setupPad(form) {
    const canvas = form.querySelector('.signature-pad');
    const input = form.querySelector('.signature-data-input');
    const clearBtn = form.querySelector('.signature-clear');
    if (!canvas || !input) return;

    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1E293B';

    let drawing = false;
    let hasDrawn = false;

    function pos(evt) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (evt.clientX - rect.left) * (canvas.width / rect.width),
        y: (evt.clientY - rect.top) * (canvas.height / rect.height),
      };
    }

    function start(evt) {
      drawing = true;
      hasDrawn = true;
      const p = pos(evt);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      evt.preventDefault();
    }

    function move(evt) {
      if (!drawing) return;
      const p = pos(evt);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      evt.preventDefault();
    }

    function end() {
      drawing = false;
    }

    canvas.style.touchAction = 'none'; // 避免觸控畫簽名時同時觸發頁面捲動
    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasDrawn = false;
      });
    }

    form.addEventListener('submit', function (evt) {
      if (!hasDrawn) {
        evt.preventDefault();
        alert('請先在框內簽名再送出');
        return;
      }
      input.value = canvas.toDataURL('image/png');
    });
  }

  document.querySelectorAll('form.signature-form').forEach(setupPad);
})();
