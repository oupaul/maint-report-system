const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const Notification = require('../models/Notification');
const Announcement = require('../models/Announcement');
const { safeReturnPath } = require('../utils/safeRedirect');

router.use(requireLogin);

router.get('/', (req, res) => {
  res.render('notifications', { items: Notification.listRecent(req.user.id, 50) });
});

// 給導覽列的紅點數字定時更新用（頁面不用整頁重新載入）
router.get('/unread-count', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ count: Notification.unreadCount(req.user.id) });
});

// 導覽列定時輪詢用：未讀數 + 目前有效的系統通知橫幅（管理員發送後，線上的人幾秒內就看得到）
router.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ count: Notification.unreadCount(req.user.id), announcements: Announcement.forBanner() });
});

router.post('/read-all', (req, res) => {
  Notification.markAllRead(req.user.id);
  res.redirect('/notifications');
});

// 點通知：標成已讀並前往對應的批次。只能操作自己的通知（findForUser 以 user_id 限定）。
router.post('/:id/open', (req, res) => {
  const n = Notification.findForUser(parseInt(req.params.id, 10), req.user.id);
  if (!n) return res.redirect('/notifications');
  Notification.markRead(n.id, req.user.id);
  res.redirect(safeReturnPath(n.link) || (n.batch_id ? `/batches/${n.batch_id}` : '/notifications'));
});

module.exports = router;
