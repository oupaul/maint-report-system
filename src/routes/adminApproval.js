const express = require('express');
const router = express.Router();

const ApprovalService = require('../services/ApprovalService');
const PermissionGroup = require('../models/PermissionGroup');

// 掛在 /admin/approval，上層（routes/admin.js）已限定管理員。網址只帶固定代碼。
const FLASH_OK = {
  saved: '已儲存簽核設定',
  added: '已新增關卡',
  updated: '已更新關卡',
  moved: '已調整順序',
  enabled: '已啟用',
  disabled: '已停用',
  deleted: '已刪除關卡',
};
const FLASH_ERR = {
  notfound: '找不到指定的關卡',
  stageused: '這個關卡已經有審核紀錄，不能刪除，只能停用（歷史紀錄會保留）',
  nostage: '要啟用簽核流程，至少需要一個啟用中的關卡',
  laststage: '至少要保留一個啟用中的關卡才能啟用簽核流程；請先新增別的關卡，或先關閉簽核流程',
};

function parseId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 群組欄位：空白 = 只有管理員；有值必須是存在的群組
function parseGroup(value) {
  if (!value) return { id: null };
  const id = parseInt(value, 10);
  if (!Number.isInteger(id) || !PermissionGroup.findById(id)) return { error: '請選擇有效的群組' };
  return { id };
}

function render(req, res, { error = null, form = {}, status = 200 } = {}) {
  res.status(status).render('admin/approval', {
    settings: ApprovalService.getSettings(),
    stages: ApprovalService.listStages({ includeInactive: true }).map(s => ({ ...s, used: ApprovalService.stageUsed(s.id) })),
    groups: PermissionGroup.findAll(),
    maxLabel: ApprovalService.MAX_STAGE_LABEL,
    form,
    ok: FLASH_OK[req.query.ok] || null,
    error: error || FLASH_ERR[req.query.err] || null,
  });
}

router.get('/', (req, res) => render(req, res));

router.post('/settings', (req, res) => {
  const enabled = req.body.enabled === 'on';
  const blockSelf = req.body.block_self_approval === 'on';
  if (enabled && ApprovalService.listStages().length === 0) return res.redirect('/admin/approval?err=nostage');
  ApprovalService.updateSettings({ enabled, block_self_approval: blockSelf });
  console.log(`[簽核] ${req.user.username} 更新簽核設定：${enabled ? '啟用' : '關閉'}、禁止自己簽核自己送的單=${blockSelf}`);
  res.redirect('/admin/approval?ok=saved');
});

router.post('/stages', (req, res) => {
  const error = ApprovalService.validateStageLabel(req.body.label);
  const group = parseGroup(req.body.group_id);
  if (error || group.error) return render(req, res, { error: error || group.error, form: { label: req.body.label, group_id: req.body.group_id }, status: 400 });
  ApprovalService.createStage(req.body.label, group.id);
  res.redirect('/admin/approval?ok=added');
});

function loadStage(req, res) {
  const stage = ApprovalService.findStage(parseId(req.params.id));
  if (!stage) {
    res.redirect('/admin/approval?err=notfound');
    return null;
  }
  return stage;
}

router.post('/stages/:id', (req, res) => {
  const stage = loadStage(req, res);
  if (!stage) return;
  const error = ApprovalService.validateStageLabel(req.body.label);
  const group = parseGroup(req.body.group_id);
  if (error || group.error) return render(req, res, { error: error || group.error, status: 400 });
  ApprovalService.updateStage(stage.id, { label: req.body.label, groupId: group.id });
  res.redirect('/admin/approval?ok=updated');
});

router.post('/stages/:id/move', (req, res) => {
  const stage = loadStage(req, res);
  if (!stage) return;
  ApprovalService.moveStage(stage.id, req.body.dir === 'up' ? 'up' : 'down');
  res.redirect('/admin/approval?ok=moved');
});

router.post('/stages/:id/toggle', (req, res) => {
  const stage = loadStage(req, res);
  if (!stage) return;
  const enable = !stage.is_active;
  // 簽核流程啟用中時，不能把最後一個啟用的關卡停用（否則沒有人能核准，批次會卡死）
  if (!enable && ApprovalService.isEnabled() && ApprovalService.listStages().length <= 1) {
    return res.redirect('/admin/approval?err=laststage');
  }
  ApprovalService.setStageActive(stage.id, enable);
  res.redirect(`/admin/approval?ok=${enable ? 'enabled' : 'disabled'}`);
});

router.post('/stages/:id/delete', (req, res) => {
  const stage = loadStage(req, res);
  if (!stage) return;
  if (ApprovalService.isEnabled() && stage.is_active && ApprovalService.listStages().length <= 1) {
    return res.redirect('/admin/approval?err=laststage');
  }
  if (!ApprovalService.removeStage(stage.id)) return res.redirect('/admin/approval?err=stageused');
  res.redirect('/admin/approval?ok=deleted');
});

module.exports = router;
