const express = require('express');
const router = express.Router();

const db = require('../models/db');
const Announcement = require('../models/Announcement');
const Notification = require('../models/Notification');
const ActivityTracker = require('../services/ActivityTracker');
const MailService = require('../services/MailService');

// 掛在 /admin/announcements，上層（routes/admin.js）已限定管理員。網址只帶固定代碼。
const FLASH_OK = { sent: '系統通知已發送', cancelled: '已撤回，橫幅馬上就會從大家的畫面消失' };
const FLASH_ERR = { notfound: '找不到這則通知', alreadydone: '這則通知已經結束（已撤回或已到期）' };

const DURATION_LABEL = { 15: '15 分鐘', 30: '30 分鐘', 60: '1 小時', 180: '3 小時', 1440: '24 小時' };

function render(req, res, { error = null, form = null, status = 200 } = {}) {
  const online = ActivityTracker.listOnline();
  const recent = Announcement.recent(20).map(a => ({ ...a, state: Announcement.stateOf(a) }));
  res.status(status).render('admin/announcements', {
    onlineUsers: new Set(online.map(e => e.userId)).size,
    mailReady: MailService.isReady(),
    maxMessage: Announcement.MAX_MESSAGE,
    durations: Announcement.DURATIONS,
    durationLabel: DURATION_LABEL,
    recent,
    form: form || { message: '', level: 'warning', duration: 30, target: 'online', email: false },
    ok: FLASH_OK[req.query.ok] || null,
    error: error || FLASH_ERR[req.query.err] || null,
  });
}

router.get('/', (req, res) => render(req, res));

router.post('/', (req, res) => {
  const message = typeof req.body.message === 'string' ? req.body.message.replace(/\r\n?/g, '\n').trim() : '';
  const level = Announcement.LEVELS.includes(req.body.level) ? req.body.level : 'info';
  const target = Announcement.TARGETS.includes(req.body.target) ? req.body.target : 'online';
  const duration = parseInt(req.body.duration, 10);
  const wantsEmail = req.body.email === 'on';
  const form = { message, level, duration, target, email: wantsEmail };

  if (!message) return render(req, res, { error: '請輸入要發送的訊息', form, status: 400 });
  if (message.length > Announcement.MAX_MESSAGE) return render(req, res, { error: `訊息不能超過 ${Announcement.MAX_MESSAGE} 個字`, form, status: 400 });
  if (/[\u0000-\u0008\u000b-\u001f]/.test(message)) return render(req, res, { error: '訊息含有不允許的字元', form, status: 400 });
  if (!Announcement.DURATIONS.includes(duration)) return render(req, res, { error: '請選擇橫幅顯示的時間', form, status: 400 });
  if (wantsEmail && !MailService.isReady()) {
    return render(req, res, { error: 'Email 寄信功能尚未啟用或設定不完整，請先到「Email 通知」設定，或取消勾選「同時寄 Email」', form, status: 400 });
  }

  // 站內通知的收件人：發送者自己不用收；「目前線上」以 5 分鐘內有操作為準，只算啟用中的帳號
  let userIds;
  if (target === 'all') {
    userIds = db.prepare('SELECT id FROM users WHERE is_active = 1').all().map(u => u.id);
  } else {
    const onlineIds = new Set(ActivityTracker.listOnline().map(e => e.userId));
    userIds = db.prepare('SELECT id FROM users WHERE is_active = 1').all().map(u => u.id).filter(id => onlineIds.has(id));
  }
  userIds = userIds.filter(id => id !== req.user.id);

  const title = level === 'warning' ? '重要系統通知' : '系統通知';
  const notificationIds = [];
  db.transaction(() => {
    Announcement.create({
      message, level, target, recipients: userIds.length, emailed: wantsEmail, createdBy: req.user.id, durationMin: duration,
    });
    for (const uid of userIds) notificationIds.push(Notification.create(uid, { type: 'system', title, message }));
  })();
  // Email 在交易提交之後才背景寄出（寄不出去不影響通知本身，結果看「Email 通知」頁的寄送紀錄）
  if (wantsEmail) notificationIds.forEach(id => MailService.queueNotificationEmail(id));

  console.log(`[系統通知] ${req.user.username} 發送（${level}、對象 ${target}、${userIds.length} 人${wantsEmail ? '、含 Email' : ''}）：${message.slice(0, 60)}`);
  res.redirect('/admin/announcements?ok=sent');
});

router.post('/:id/cancel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = Number.isInteger(id) ? Announcement.findById(id) : null;
  if (!a) return res.redirect('/admin/announcements?err=notfound');
  if (!Announcement.cancel(id)) return res.redirect('/admin/announcements?err=alreadydone');
  console.log(`[系統通知] ${req.user.username} 撤回通知 #${id}`);
  res.redirect('/admin/announcements?ok=cancelled');
});

module.exports = router;
