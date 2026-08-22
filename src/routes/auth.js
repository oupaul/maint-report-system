const express = require('express');
const router = express.Router();

const User = require('../models/User');
const AuthService = require('../services/AuthService');

router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).render('login', { error: '請輸入帳號與密碼' });
  }

  const user = User.findByUsername(username);
  if (!user || !user.is_active) {
    return res.status(401).render('login', { error: '帳號或密碼錯誤' });
  }

  const ok = await AuthService.verifyPassword(user.password_hash, password);
  if (!ok) {
    return res.status(401).render('login', { error: '帳號或密碼錯誤' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
  };

  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
