const express = require('express');
const router = express.Router();

const PermissionGroup = require('../models/PermissionGroup');
const { PERMISSIONS } = require('../utils/permissions');
const ApprovalService = require('../services/ApprovalService');

// 掛在 /admin/groups，上層（routes/admin.js）已限定管理員。
// 網址只帶固定代碼，不帶任何文字（避免做出一個網址讓管理員頁面顯示任意內容）。
const FLASH_OK = { created: '已建立群組', saved: '已儲存群組設定', deleted: '已刪除群組' };
const FLASH_ERR = {
  notfound: '找不到指定的群組',
  instage: '這個群組目前被簽核關卡使用中，請先到「簽核流程」把該關卡改成其他群組（或改成只有管理員）再刪除',
  hasmembers: '這個群組還有成員，請先把成員移到其他群組（或改成不屬於任何群組）再刪除',
};

function parseId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function flash(req) {
  return { ok: FLASH_OK[req.query.ok] || null, err: FLASH_ERR[req.query.err] || null };
}

router.get('/', (req, res) => {
  const f = flash(req);
  res.render('admin/groups', {
    groups: PermissionGroup.findAll(),
    permissions: PERMISSIONS,
    ok: f.ok,
    error: f.err,
  });
});

function renderForm(req, res, { group, form, error = null, status = 200 }) {
  res.status(status).render('admin/group', {
    group,
    form,
    members: group ? PermissionGroup.members(group.id) : [],
    permissions: PERMISSIONS,
    maxName: PermissionGroup.MAX_NAME,
    maxDesc: PermissionGroup.MAX_DESC,
    ok: flash(req).ok,
    error: error || flash(req).err,
  });
}

router.get('/new', (req, res) => {
  renderForm(req, res, { group: null, form: { name: '', description: '', permissions: [] } });
});

router.post('/', (req, res) => {
  const form = { name: req.body.name || '', description: req.body.description || '', permissions: [].concat(req.body.permissions || []) };
  const error = PermissionGroup.validateName(form.name);
  if (error) return renderForm(req, res, { group: null, form, error, status: 400 });
  const group = PermissionGroup.create(form);
  console.log(`[權限群組] ${req.user.username} 建立群組「${group.name}」，權限：${group.permissions.join(', ') || '（無）'}`);
  res.redirect(`/admin/groups/${group.id}?ok=created`);
});

function load(req, res) {
  const group = PermissionGroup.findById(parseId(req.params.id));
  if (!group) {
    res.redirect('/admin/groups?err=notfound');
    return null;
  }
  return group;
}

router.get('/:id', (req, res) => {
  const group = load(req, res);
  if (!group) return;
  renderForm(req, res, { group, form: { name: group.name, description: group.description || '', permissions: group.permissions } });
});

router.post('/:id', (req, res) => {
  const group = load(req, res);
  if (!group) return;
  const form = { name: req.body.name || '', description: req.body.description || '', permissions: [].concat(req.body.permissions || []) };
  const error = PermissionGroup.validateName(form.name, group.id);
  if (error) return renderForm(req, res, { group, form, error, status: 400 });
  PermissionGroup.update(group.id, form);
  const after = PermissionGroup.findById(group.id);
  console.log(`[權限群組] ${req.user.username} 修改群組「${after.name}」，權限：${after.permissions.join(', ') || '（無）'}`);
  res.redirect(`/admin/groups/${group.id}?ok=saved`);
});

router.post('/:id/delete', (req, res) => {
  const group = load(req, res);
  if (!group) return;
  if (ApprovalService.groupInUse(group.id)) return res.redirect(`/admin/groups/${group.id}?err=instage`);
  if (!PermissionGroup.remove(group.id)) return res.redirect(`/admin/groups/${group.id}?err=hasmembers`);
  console.log(`[權限群組] ${req.user.username} 刪除群組「${group.name}」`);
  res.redirect('/admin/groups?ok=deleted');
});

module.exports = router;
