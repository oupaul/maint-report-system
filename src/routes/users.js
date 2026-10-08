const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const User = require('../models/User');
const AuthService = require('../services/AuthService');
const { USER_ROLES, isValidRole } = require('../utils/validators');
const { validatePasswordStrength } = require('../utils/password');

router.get('/', requireRole('admin'), (req, res) => {
  const users = User.findAll();
  res.render('users/list', { users });
});

router.get('/new', requireRole('admin'), (req, res) => {
  res.render('users/form', { targetUser: null, roles: USER_ROLES, error: null });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { username, password, display_name, role, m365_email } = req.body;

  if (!username || !password || !isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: '請輸入帳號、密碼並選擇有效的角色',
    });
  }

  const weakCreate = validatePasswordStrength(password, { username });
  if (weakCreate) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: weakCreate,
    });
  }

  if (User.findByUsername(username)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: '此帳號已存在',
    });
  }

  if (m365_email && User.findByM365Email(m365_email)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      error: '此 M365 Email 已被其他帳號使用',
    });
  }

  const password_hash = await AuthService.hashPassword(password);
  User.create({ username, password_hash, display_name, role, m365_email });
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

  const { display_name, role, is_active, new_password, m365_email } = req.body;

  if (!isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      error: '請選擇有效的角色',
    });
  }

  if (m365_email) {
    const existing = User.findByM365Email(m365_email);
    if (existing && existing.id !== targetUser.id) {
      return res.status(400).render('users/form', {
        targetUser: { ...targetUser, ...req.body },
        roles: USER_ROLES,
        error: '此 M365 Email 已被其他帳號使用',
      });
    }
  }

  const wantsPasswordReset = !!(new_password && new_password.trim().length > 0);
  if (wantsPasswordReset) {
    const weakReset = validatePasswordStrength(new_password.trim(), { username: targetUser.username });
    if (weakReset) {
      return res.status(400).render('users/form', {
        targetUser: { ...targetUser, ...req.body },
        roles: USER_ROLES,
        error: weakReset,
      });
    }
  }

  User.update(targetUser.id, {
    display_name,
    role,
    is_active: is_active === 'on' || is_active === '1',
    m365_email,
  });

  if (wantsPasswordReset) {
    const password_hash = await AuthService.hashPassword(new_password.trim());
    // 管理員幫別人重設的密碼，本人下次登入要自己再改一次
    User.updatePassword(targetUser.id, password_hash, { mustChange: true });
  }

  res.redirect('/users');
});

module.exports = router;
