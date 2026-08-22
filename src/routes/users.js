const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const User = require('../models/User');
const AuthService = require('../services/AuthService');
const { USER_ROLES, isValidRole } = require('../utils/validators');

router.get('/', requireRole('admin'), (req, res) => {
  const users = User.findAll();
  res.render('users/list', { users });
});

router.get('/new', requireRole('admin'), (req, res) => {
  res.render('users/form', { targetUser: null, roles: USER_ROLES, error: null });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { username, password, display_name, role } = req.body;

  if (!username || !password || !isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: '請輸入帳號、密碼並選擇有效的角色',
    });
  }

  if (User.findByUsername(username)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: '此帳號已存在',
    });
  }

  const password_hash = await AuthService.hashPassword(password);
  User.create({ username, password_hash, display_name, role });
  res.redirect('/users');
});

router.get('/:id/edit', requireRole('admin'), (req, res) => {
  const targetUser = User.findById(req.params.id);
  if (!targetUser) {
    return res.status(404).render('error', { title: '找不到使用者', message: '找不到指定的使用者' });
  }
  res.render('users/form', { targetUser, roles: USER_ROLES, error: null });
});

router.post('/:id/edit', requireRole('admin'), async (req, res) => {
  const targetUser = User.findById(req.params.id);
  if (!targetUser) {
    return res.status(404).render('error', { title: '找不到使用者', message: '找不到指定的使用者' });
  }

  const { display_name, role, is_active, new_password } = req.body;

  if (!isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      error: '請選擇有效的角色',
    });
  }

  User.update(targetUser.id, {
    display_name,
    role,
    is_active: is_active === 'on' || is_active === '1',
  });

  if (new_password && new_password.trim().length > 0) {
    const password_hash = await AuthService.hashPassword(new_password.trim());
    User.updatePassword(targetUser.id, password_hash);
  }

  res.redirect('/users');
});

module.exports = router;
