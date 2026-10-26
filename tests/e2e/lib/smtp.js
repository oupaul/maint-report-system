// 測試用的最小 SMTP 伺服器：收信、記錄、解析 MIME，讓寄信測試不需要真的郵件主機。
// 支援 EHLO、AUTH PLAIN／LOGIN、MAIL／RCPT／DATA／RSET／NOOP／QUIT；沒有 TLS（nodemailer 看不到 STARTTLS 就走明文）。
// 可用 stub.failAuth／stub.rejectRcpt 模擬登入失敗與拒收。
const net = require('net');

class StubSmtp {
  constructor({ user = 'mailer', pass = 'mail-pass-1' } = {}) {
    this.user = user;
    this.pass = pass;
    this.failAuth = false;
    this.rejectRcpt = false;
    this.messages = [];     // { from, rcpts, raw, auth, mime }
    this.authAttempts = []; // { user, pass, ok }
    this.server = null;
    this.port = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((sock) => this._serve(sock));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
    });
  }

  stop() { return new Promise((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); this.server.closeAllConnections?.(); }); }
  clear() { this.messages = []; this.authAttempts = []; }

  _serve(sock) {
    sock.setEncoding('latin1');
    const send = (s) => sock.write(`${s}\r\n`);
    let buf = '';
    let state = { authed: false, from: null, rcpts: [], data: null, login: null, authUser: null };
    send('220 stub.test ESMTP ready');
    const tryAuth = (user, pass) => {
      const ok = !this.failAuth && user === this.user && pass === this.pass;
      this.authAttempts.push({ user, pass, ok });
      if (ok) { state.authed = true; state.authUser = user; send('235 2.7.0 Authentication successful'); } else send('535 5.7.8 Authentication credentials invalid');
    };
    const line = (l) => {
      if (state.data !== null) return; // DATA 內容在下面處理
      if (state.login) {
        const v = Buffer.from(l, 'base64').toString('utf8');
        if (state.login.step === 'user') { state.login = { step: 'pass', user: v }; send('334 UGFzc3dvcmQ6'); } else { const u = state.login.user; state.login = null; tryAuth(u, v); }
        return;
      }
      const cmd = l.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { sock.write('250-stub.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 20971520\r\n'); return; }
      if (cmd === 'HELO') return send('250 stub.test');
      if (cmd === 'AUTH') {
        const [, mech, initial] = l.split(' ');
        if ((mech || '').toUpperCase() === 'PLAIN') {
          if (!initial) { state.login = null; state.plain = true; return send('334 '); }
          const [, u, p] = Buffer.from(initial, 'base64').toString('utf8').split('\0');
          return tryAuth(u, p);
        }
        if ((mech || '').toUpperCase() === 'LOGIN') { state.login = { step: 'user' }; return send('334 VXNlcm5hbWU6'); }
        return send('504 5.5.4 mechanism not supported');
      }
      if (state.plain) { state.plain = false; const [, u, p] = Buffer.from(l, 'base64').toString('utf8').split('\0'); return tryAuth(u, p); }
      if (cmd === 'MAIL') {
        if (!state.authed) return send('530 5.7.0 Authentication required');
        state.from = (l.match(/<([^>]*)>/) || [])[1] || ''; state.rcpts = []; return send('250 2.1.0 OK');
      }
      if (cmd === 'RCPT') {
        if (this.rejectRcpt) return send('550 5.1.1 Mailbox unavailable');
        state.rcpts.push((l.match(/<([^>]*)>/) || [])[1] || ''); return send('250 2.1.5 OK');
      }
      if (cmd === 'DATA') { if (!state.rcpts.length) return send('503 5.5.1 need RCPT first'); state.data = ''; return send('354 End data with <CR><LF>.<CR><LF>'); }
      if (cmd === 'RSET') { state.from = null; state.rcpts = []; return send('250 OK'); }
      if (cmd === 'NOOP') return send('250 OK');
      if (cmd === 'QUIT') { send('221 Bye'); return sock.end(); }
      return send('502 5.5.2 command not recognized');
    };
    sock.on('data', (chunk) => {
      buf += chunk;
      for (;;) {
        if (state.data !== null) {
          const end = (state.data + buf).indexOf('\r\n.\r\n');
          if (end < 0) { state.data += buf; buf = ''; return; }
          const all = state.data + buf;
          const raw = Buffer.from(all.slice(0, end + 2), 'latin1').toString('latin1').replace(/\r\n\.\./g, '\r\n.');
          buf = all.slice(end + 5); state.data = null;
          const rawBuf = Buffer.from(raw, 'latin1');
          this.messages.push({ from: state.from, rcpts: state.rcpts.slice(), auth: state.authUser, raw: rawBuf, mime: parseMime(rawBuf) });
          send('250 2.0.0 OK queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const l = buf.slice(0, i); buf = buf.slice(i + 2);
        line(l);
      }
    });
    sock.on('error', () => {});
  }
}

// ---------- MIME ----------

function decodeQp(s) {
  return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
}
function decodeBody(body, encoding) {
  const e = (encoding || '7bit').toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (e === 'quoted-printable') return decodeQp(body);
  return Buffer.from(body, 'latin1');
}
// RFC 2047：=?UTF-8?B?...?= ／ =?UTF-8?Q?...?=（相鄰的編碼字之間的空白要忽略）
function decodeWords(v) {
  return v.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    const b = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQp(txt.replace(/_/g, ' '));
    return b.toString(/utf-?8/i.test(cs) ? 'utf8' : 'latin1');
  });
}
function parseHeaders(block) {
  const headers = []; // 保留順序與重複，方便檢查有沒有多出來的標頭
  for (const l of block.split('\r\n')) {
    if (/^[ \t]/.test(l) && headers.length) headers[headers.length - 1].value += ` ${l.trim()}`;
    else { const i = l.indexOf(':'); if (i > 0) headers.push({ name: l.slice(0, i).toLowerCase(), value: l.slice(i + 1).trim() }); }
  }
  return headers;
}
function parseMime(raw) {
  const s = raw.toString('latin1');
  const i = s.indexOf('\r\n\r\n');
  const headers = parseHeaders(i < 0 ? s : s.slice(0, i));
  const body = i < 0 ? '' : s.slice(i + 4);
  const h = (n) => { const x = headers.find(y => y.name === n); return x ? x.value : ''; };
  const ctype = h('content-type');
  const node = { headers, header: (n) => decodeWords(h(n)), type: (ctype.split(';')[0] || 'text/plain').trim().toLowerCase(), ctype, parts: [] };
  const bm = ctype.match(/boundary="?([^";]+)"?/i);
  if (node.type.startsWith('multipart/') && bm) {
    const segs = body.split(`--${bm[1]}`).slice(1);
    for (const seg of segs) { if (seg.startsWith('--')) break; node.parts.push(parseMime(Buffer.from(seg.replace(/^\r\n/, '').replace(/\r\n$/, ''), 'latin1'))); }
  } else {
    node.content = decodeBody(body, h('content-transfer-encoding'));
    const cd = h('content-disposition') + ';' + ctype;
    const fn = cd.match(/(?:file)?name\*?="?([^";]+)"?/i);
    node.filename = fn ? decodeURIComponent(decodeWords(fn[1]).replace(/^UTF-8''/i, '')) : null;
    node.text = /^text\//.test(node.type) ? node.content.toString('utf8') : null;
  }
  return node;
}
// 攤平成所有葉節點
function leaves(node) { return node.parts.length ? node.parts.flatMap(leaves) : [node]; }

module.exports = { StubSmtp, parseMime, leaves };
