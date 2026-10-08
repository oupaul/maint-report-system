const express = require('express');
const router = express.Router();

const { requireRole } = require('../middleware/auth');
const User = require('../models/User');
const PermissionGroup = require('../models/PermissionGroup');
const MailService = require('../services/MailService');
const AuthService = require('../services/AuthService');
const { USER_ROLES, isValidRole } = require('../utils/validators');
const { validatePasswordStrength } = require('../utils/password');

// 群組欄位：空白 = 不屬於任何群組；有值就必須是存在的群組。回傳 { id } 或 { error }
function parseGroup(value) {
  if (!value) return { id: null };
  const id = parseInt(value, 10);
  if (!Number.isInteger(id) || !PermissionGroup.findById(id)) return { error: '請選擇有效的權限群組' };
  return { id };
}

router.get('/', requireRole('admin'), (req, res) => {
  const users = User.findAll();
  res.render('users/list', { users });
});

router.get('/new', requireRole('admin'), (req, res) => {
  res.render('users/form', { targetUser: null, roles: USER_ROLES, groups: PermissionGroup.findAll(), error: null });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { username, password, display_name, role, m365_email, email } = req.body;
  const group = parseGroup(req.body.group_id);

  if (!username || !password || !isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '請輸入帳號、密碼並選擇有效的角色',
    });
  }

  if (email && !MailService.isValidEmail(email)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '通知用的 Email 格式不正確',
    });
  }

  if (group.error) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: group.error,
    });
  }

  const weakCreate = validatePasswordStrength(password, { username });
  if (weakCreate) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: weakCreate,
    });
  }

  if (User.findByUsername(username)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '此帳號已存在',
    });
  }

  if (m365_email && User.findByM365Email(m365_email)) {
    return res.status(400).render('users/form', {
      targetUser: req.body,
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '此 M365 Email 已被其他帳號使用',
    });
  }

  const password_hash = await AuthService.hashPassword(password);
  User.create({ username, password_hash, display_name, role, m365_email, group_id: group.id, email });
  res.redirect('/users');
});

router.get('/:id/edit', requireRole('admin'), (req, res) => {
  const targetUser = User.findById(req.params.id);
  if (!targetUser) {
    return res.status(404).render('error', { title: '找不到使用者', message: '找不到指定的使用者' });
  }
  res.render('users/form', { targetUser, roles: USER_ROLES, groups: PermissionGroup.findAll(), error: null });
});

router.post('/:id/edit', requireRole('admin'), async (req, res) => {
  const targetUser = User.findById(req.params.id);
  if (!targetUser) {
    return res.status(404).render('error', { title: '找不到使用者', message: '找不到指定的使用者' });
  }

  const { display_name, role, is_active, new_password, m365_email, email } = req.body;
  const group = parseGroup(req.body.group_id);
  const willBeActive = is_active === 'on' || is_active === '1';

  if (!isValidRole(role)) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '請選擇有效的角色',
    });
  }

  if (email && !MailService.isValidEmail(email)) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '通知用的 Email 格式不正確',
    });
  }

  if (group.error) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: group.error,
    });
  }

  // 系統一定要保留至少一位啟用中的管理員，否則沒有人能管理使用者、群組與系統設定
  const demotingOrDisabling = targetUser.role === 'admin' && targetUser.is_active && (role !== 'admin' || !willBeActive);
  if (demotingOrDisabling && User.countActiveAdmins() <= 1) {
    return res.status(400).render('users/form', {
      targetUser: { ...targetUser, ...req.body },
      roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
      error: '系統必須保留至少一位啟用中的管理員，無法停用或降級最後一位管理員',
    });
  }

  if (m365_email) {
    const existing = User.findByM365Email(m365_email);
    if (existing && existing.id !== targetUser.id) {
      return res.status(400).render('users/form', {
        targetUser: { ...targetUser, ...req.body },
        roles: USER_ROLES,
      groups: PermissionGroup.findAll(),
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
      groups: PermissionGroup.findAll(),
        error: weakReset,
      });
    }
  }

  User.update(targetUser.id, {
    display_name,
    role,
    is_active: willBeActive,
    m365_email,
    group_id: group.id,
    email,
  });

  if (wantsPasswordReset) {
    const password_hash = await AuthService.hashPassword(new_password.trim());
    // 管理員幫別人重設的密碼，本人下次登入要自己再改一次
    User.updatePassword(targetUser.id, password_hash, { mustChange: true });
  }

  res.redirect('/users');
});

module.exports = router;
