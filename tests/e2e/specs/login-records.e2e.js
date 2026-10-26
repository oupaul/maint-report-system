// 登入紀錄與使用時間：登入時間、使用時間長度（閒置超過 30 分鐘就分段、閒置不計入）、狀態，以及管理員的統計與明細頁。
// 前半用「模擬時間」直接驗證 LoginTracker／LoginSession 的邏輯，後半從網頁真的登入登出。
module.exports = {
  name: '登入紀錄與使用時間',
  needs: ['browser'],
  async run(t) {
    // ===== 1. 邏輯（模擬時間） =====
    const LoginTracker = t.require('src/services/LoginTracker');
    const LoginSession = t.require('src/models/LoginSession');
    const { formatTaipei } = t.require('src/utils/time');
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    const adv = (ms) => { now += ms; };
    const MIN = 60000;
    try {
      const rows = () => t.q('SELECT * FROM login_sessions ORDER BY id');
      const mkreq = (sid, p = '/assets', userId = 1) => ({ user: { id: userId }, sessionID: sid, path: p, ip: '10.0.0.9', get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36', session: {} });
      const r1 = mkreq('sess-A');
      LoginTracker.start(r1, { id: 1 }, 'password');
      let R = rows();
      t.ok(R.length === 1 && R[0].method === 'password' && R[0].ended_at === null && R[0].ip === '10.0.0.9' && /Chrome \/ macOS/.test(R[0].agent), '登入建立一列（方式、IP、裝置）');
      t.ok(R[0].session_key.length === 32 && !R[0].session_key.includes('sess-A'), '不存原始 session id（只存雜湊）');
      const startedAt = R[0].started_at;
      adv(10000); LoginTracker.touch(r1); R = rows();
      t.ok(R[0].last_seen_at === startedAt, '一分鐘內的操作不寫資料庫（節流）');
      adv(61000); LoginTracker.touch(r1); R = rows();
      t.ok(R[0].last_seen_at > startedAt && R.length === 1, '超過一分鐘才寫一次最後操作時間，仍是同一列');
      const lastSeen = R[0].last_seen_at;
      adv(5 * MIN); LoginTracker.touch(mkreq('sess-A', '/notifications/status')); R = rows();
      t.ok(R[0].last_seen_at === lastSeen && LoginTracker._state.get(LoginTracker.keyOf('sess-A')).lastSeen < now - 4 * MIN, '前端背景輪詢（通知）不算「使用」');
      adv(10 * MIN); LoginTracker.touch(r1); R = rows();
      t.ok(R.length === 1, '30 分鐘內有操作：同一段');
      const lastActive = LoginTracker._state.get(LoginTracker.keyOf('sess-A')).lastSeen;
      adv(31 * MIN); LoginTracker.touch(r1); R = rows();
      t.ok(R.length === 2 && R[0].ended_at && R[0].end_reason === 'idle' && R[1].ended_at === null && R[1].session_key === R[0].session_key, '閒置超過 30 分鐘：舊的一段以「閒置」結束、開新的一段（同一個登入）');
      t.ok(R[0].ended_at === formatTaipei(lastActive), '閒置那段結束在「最後一次真正操作」的時間，不是回來的時間');
      adv(2 * MIN); LoginTracker._state.clear(); LoginTracker.touch(r1); R = rows();
      t.ok(R.length === 2, '服務重啟（記憶體清空）後從資料庫接回，不重複開列');
      LoginTracker._state.clear(); adv(40 * MIN); LoginTracker.touch(r1); R = rows();
      t.ok(R.length === 3 && R[1].end_reason === 'idle' && R[2].ended_at === null, '重啟加上空窗 40 分鐘：上一段以閒置結束、開新的一段');
      adv(3 * MIN); LoginTracker.end('sess-A', 'logout'); R = rows();
      t.ok(R[2].ended_at && R[2].end_reason === 'logout', '登出：結束目前這一段');
      LoginTracker.touch(r1); R = rows();
      t.ok(R.length === 4 && R[3].ended_at === null, '登出後用舊 session id 的請求會開新的一列（不會當掉）');
      LoginTracker.end('sess-A', 'logout');
      const before = rows().length;
      LoginTracker.touch({ user: null, sessionID: 'x', path: '/', get: () => '' });
      LoginTracker.touch({ user: { id: 1 }, sessionID: null, path: '/', get: () => '' });
      t.ok(rows().length === before, '沒登入的請求不記錄');
      const r2 = mkreq('sess-B', '/assets', 2);
      LoginTracker.start(r2, { id: 2 }, 'm365');
      R = rows();
      t.ok(R[R.length - 1].user_id === 2 && R[R.length - 1].method === 'm365', '另一個人／另一個登入是獨立的一列');
      const S = LoginSession.sessions({ userId: 1, days: 30, limit: 50 });
      const a = S.find(s => s.segs >= 3);
      t.ok(a && a.secs > 0, '多段的登入把各段加總');
      const segSum = t.q('SELECT SUM((julianday(COALESCE(ended_at, last_seen_at)) - julianday(started_at)) * 86400) AS s FROM login_sessions WHERE session_key = ?', LoginTracker.keyOf('sess-A'))[0].s;
      t.ok(Math.abs(a.secs - Math.round(segSum)) <= 1, '總使用時間＝各段加總（閒置的空窗不計入）');
      t.ok(LoginSession.sessions({ userId: 2, days: 30, limit: 5 })[0].status === 'online', '剛操作過＝線上');
      adv(10 * MIN);
      t.ok(LoginSession.sessions({ userId: 2, days: 30, limit: 5 })[0].status === 'idle_now', '閒置 10 分鐘＝閒置中');
      adv(30 * MIN);
      t.ok(LoginSession.sessions({ userId: 2, days: 30, limit: 5 })[0].status === 'idle_end', '閒置 40 分鐘又沒登出＝閒置逾時');
      t.ok(LoginSession.sessions({ userId: 1, days: 30, limit: 50 }).some(s => s.status === 'logout'), '有按登出＝已登出');
      const u1 = LoginSession.summarize(LoginSession.sessions({ days: 30, limit: 100 })).find(x => x.user_id === 1);
      t.ok(u1 && u1.logins === 1 && u1.secs > 0 && u1.avg === Math.round(u1.secs / u1.logins), '彙總：登入次數、累計與平均使用時間');
      t.q("UPDATE login_sessions SET started_at = '2000-01-01 00:00:00' WHERE user_id = 2");
      t.ok(LoginSession.prune() >= 1 && !t.q('SELECT 1 FROM login_sessions WHERE user_id = 2').length, '超過保留期限（180 天）的紀錄會被清除');
    } finally { Date.now = realNow; }
    t.q('DELETE FROM login_sessions');

    // ===== 2. 從網頁真的登入登出 =====
    const wang = await t.login('wang');
    let R = t.q('SELECT ls.*, u.username FROM login_sessions ls JOIN users u ON u.id = ls.user_id ORDER BY ls.id');
    t.ok(R.length === 1 && R[0].username === 'wang' && R[0].method === 'password' && R[0].ended_at === null && /Chrome/.test(R[0].agent), '真的登入：建立一列（wang、帳號密碼、Chrome）');
    await t.go(wang, '/assets'); await t.go(wang, '/batches');
    t.ok(t.count('login_sessions', '1=1') === 1, '同一個登入的多次瀏覽不會多出列');
    const admin = await t.login('admin');
    await t.go(admin, '/admin/logins');
    const body = await admin.$eval('body', e => e.innerText);
    t.ok(/各使用者統計/.test(body) && /wang/.test(body) && /admin/.test(body), '管理員看到各使用者統計（含 wang 與 admin）');
    const wangRow = await admin.$$eval('table:nth-of-type(1) tbody tr', a => a.map(r => r.innerText.replace(/\s+/g, ' ')).find(x => /^wang/.test(x)));
    t.ok(/wang.*1.*不到 1 分鐘/.test(wangRow || ''), 'wang：1 次登入、使用時間不到 1 分鐘');
    const detail = await admin.$$eval('.card:last-of-type tbody tr', a => a.map(r => r.innerText.replace(/\s+/g, ' ')));
    t.ok(detail.some(x => /^wang/.test(x) && /線上/.test(x) && /帳號密碼/.test(x) && /Chrome/.test(x)), '明細：wang 線上、登入方式、裝置');
    await Promise.all([wang.waitForNavigation(), wang.evaluate(() => document.querySelector('form[action="/logout"]').submit())]);
    R = t.q('SELECT * FROM login_sessions WHERE user_id = ?', t.uid('wang'));
    t.ok(R.length === 1 && R[0].end_reason === 'logout' && R[0].ended_at, '登出：這一列結束（logout）');
    await t.go(admin, `/admin/logins?user=${t.uid('wang')}`);
    const cards = await admin.$$eval('.stat-card', a => a.map(x => x.innerText.replace(/\s+/g, ' ')));
    t.ok(cards.length === 3 && /^1 /.test(cards[0]) && /wang/.test(cards[0]) && /不到 1 分鐘/.test(cards[1]), '單一使用者：登入次數、累計與平均使用時間三張卡片');
    t.ok((await admin.$$eval('.card:last-of-type tbody tr', a => a.map(r => r.innerText)))[0].includes('已登出'), '明細顯示「已登出」');
    await t.go(admin, '/admin/status');
    t.ok((await admin.$$eval('h2', a => a.map(x => x.textContent))).includes('最近登入'), '系統狀態頁仍有「最近登入」');
    const statusRows = await admin.$$eval('.card', cs => { const c = cs.find(x => x.querySelector('h2') && x.querySelector('h2').textContent === '最近登入'); return [...c.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ')); });
    t.ok(statusRows.some(x => /^wang/.test(x) && /已登出/.test(x) && /不到 1 分鐘/.test(x)) && statusRows.some(x => /^admin/.test(x) && /線上/.test(x)), '系統狀態頁：每個人的使用時間與狀態');
    t.ok(await admin.$$eval('a', a => a.some(x => x.getAttribute('href') === '/admin/logins' && /完整登入紀錄/.test(x.textContent))), '系統狀態頁有連到完整登入紀錄');
    t.ok(await admin.$$eval('a', a => a.some(x => x.getAttribute('href') === '/admin/logins' && x.textContent.trim() === '登入紀錄')), '管理員選單有「登入紀錄」');
    for (const u of ['/admin/logins?days=9999&user=abc', '/admin/logins?user=999999', '/admin/logins?days=7&user=%27%20OR%201%3D1']) {
      t.ok((await admin.goto(`${t.base}${u}`, { waitUntil: 'networkidle0' })).status() === 200, `奇怪的參數不會出錯：${u}`);
    }
    const lin = await t.login('lin');
    t.ok((await lin.goto(`${t.base}/admin/logins`)).status() === 403, '技術人員不能看登入紀錄（403）');
    t.ok((await fetch(`${t.base}/admin/logins`, { redirect: 'manual' })).status === 302, '未登入導向登入頁');
    t.ok(!(await admin.evaluate(() => document.body.innerText)).includes('NaN'), '頁面上沒有 NaN');
  },
};
