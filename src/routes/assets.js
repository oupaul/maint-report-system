const express = require('express');
const router = express.Router();

// 類型下拉選單：啟用中的類型，加上這個設備目前正在用的類型（即使已停用也要保留，才不會一存檔就被改掉）
// 驗證失敗要把使用者剛輸入的自訂欄位值帶回表單
function customInput(body) {
  const out = {};
  Object.keys(body || {}).forEach(k => { const m = /^cf_(\d+)$/.exec(k); if (m) out[m[1]] = body[k]; });
  return out;
}

function formData(asset, error) {
  // 驗證失敗時傳進來的是 { ...資產, ...req.body }，body.tags 是使用者輸入的字串：留作輸入框內容
  if (asset && typeof asset.tags === 'string') asset = { ...asset, tags_input: asset.tags, tags: [] };
  const current = asset && asset.id ? asset.category : null;
  const categories = AssetCategory.selectableCodes(current);
  const shownCategory = asset && asset.category ? asset.category : categories[0];
  return {
    asset,
    customFields: AssetField.formFields(asset ? { ...asset, custom_input: customInput(asset) } : null, shownCategory),
    categories,
    categoryLabels: AssetCategory.labelMap(),
    categoryLocked: !!(asset && asset.id && Asset.hasRecords(asset.id)),
    // 格式問題與重複只提示、不擋存檔；編輯頁每次顯示都即時計算，所以日後別台設備改了也會反映
    warnings: asset && asset.id ? assetFields.warningsFor(asset, Asset.findAll({ includeInactive: true })) : [],
    saved: false,
    // 標籤輸入框的內容（驗證失敗時帶回使用者剛輸入的）、可點選加入的現有標籤、位置自動完成清單
    tagsText: asset && typeof asset.tags_input === 'string' ? asset.tags_input : (asset && asset.tags ? asset.tags.join(', ') : ''),
    tagSuggestions: AssetTag.inUse(),
    locations: Asset.locations(),
    error,
  };
}

const { requireLogin, requirePermission } = require('../middleware/auth');
const Asset = require('../models/Asset');
const assetFields = require('../utils/assetFields');
const AssetCategory = require('../models/AssetCategory');
const AssetField = require('../models/AssetField');
const AssetTag = require('../models/AssetTag');
const InspectionVolume = require('../models/InspectionVolume');

const SORT_KEYS = ['category', 'name', 'location', 'ip_address', 'hostname', 'brand', 'serial_number', 'asset_tag', 'purchase_date', 'is_active'];
const PER_PAGE = [50, 100, 200];

// 位置是自由輸入的：多個空白收成一個、去頭尾空白，減少「1F 前台」「1F  前台」被當成兩個位置
function cleanLocation(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

router.get('/', requireLogin, (req, res) => {
  const str = (v, max = 100) => String(v || '').slice(0, max);
  const params = {
    q: str(req.query.q),
    category: str(req.query.category, 60),
    location: str(req.query.location),
    status: ['1', '0'].includes(req.query.status) ? req.query.status : '',
    tag: str(req.query.tag, 40),
    sort: SORT_KEYS.includes(req.query.sort) ? req.query.sort : 'category',
    dir: req.query.dir === 'desc' ? 'desc' : 'asc',
    grouped: req.query.group !== '0',
    per: PER_PAGE.includes(parseInt(req.query.per, 10)) ? parseInt(req.query.per, 10) : 50,
    page: parseInt(req.query.page, 10) || 1,
  };
  const result = Asset.query(params);
  // 組出保留目前篩選／排序條件的網址（換頁、換排序、切換分組時用）
  const link = (over = {}) => {
    const m = { ...params, group: params.grouped ? '1' : '0', ...over };
    delete m.grouped;
    const qs = new URLSearchParams();
    Object.entries(m).forEach(([k, v]) => {
      if (v === '' || v == null) return;
      if (k === 'page' && Number(v) === 1) return;
      if (k === 'per' && Number(v) === 50) return;
      if (k === 'group' && v === '1') return;
      if (k === 'sort' && v === 'category') return;
      if (k === 'dir' && v === 'asc') return;
      qs.set(k, v);
    });
    const text = qs.toString();
    return '/assets' + (text ? '?' + text : '');
  };
  res.render('assets/list', {
    ...result,
    params,
    link,
    totalAll: Asset.count(),
    categoryLabels: AssetCategory.labelMap(),
    categoryOrder: AssetCategory.findAll().map(c => c.code),
    locations: Asset.locations(),
    tagList: AssetTag.inUse(),
    perOptions: PER_PAGE,
    capacityAssets: InspectionVolume.assetIdsWithData(),
    listFields: AssetField.findAll({ activeOnly: true }).filter(f => f.show_in_list),
  });
});

router.get('/new', requirePermission('assets.manage'), (req, res) => {
  res.render('assets/form', formData(null, null));
});

router.post('/', requirePermission('assets.manage'), (req, res) => {
  const { name, category, location, notes } = req.body;

  if (!name || !AssetCategory.isSelectable(category)) {
    return res.status(400).render('assets/form', formData(req.body, '請輸入資產名稱並選擇有效的類別'));
  }
  const fields = assetFields.normalize(req.body);
  if (fields.error) return res.status(400).render('assets/form', formData(req.body, fields.error));
  const custom = AssetField.parse(req.body, category);
  if (custom.error) return res.status(400).render('assets/form', formData(req.body, custom.error));
  const tags = AssetTag.parse(req.body.tags);
  if (tags.error) return res.status(400).render('assets/form', formData(req.body, tags.error));

  const asset = Asset.create({ name, category, location: cleanLocation(location), notes, ...fields.values, custom: custom.values, tags: tags.tags });
  res.redirect(`/assets/${asset.id}/edit?saved=1`);
});

router.get('/:id/edit', requirePermission('assets.manage'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }
  res.render('assets/form', { ...formData(asset, null), saved: req.query.saved === '1' });
});

router.post('/:id/edit', requirePermission('assets.manage'), (req, res) => {
  const asset = Asset.findById(req.params.id);
  if (!asset) {
    return res.status(404).render('error', { title: '找不到資產', message: '找不到指定的資產' });
  }

  const { name, category, location, notes, is_active } = req.body;

  // 已有檢查紀錄的資產不能改類型（舊紀錄對應的是原本類型的檢查項目）；
  // 沒改類型的話，即使這個類型已被停用也允許（只是不讓新設備選到它）
  const categoryChanged = category !== asset.category;
  if (categoryChanged && Asset.hasRecords(asset.id)) {
    return res.status(400).render('assets/form', formData({ ...asset, ...req.body, category: asset.category }, '這個設備已經有檢查紀錄，不能變更類型'));
  }
  if (!name || !(categoryChanged ? AssetCategory.isSelectable(category) : !!AssetCategory.findByCode(category))) {
    return res.status(400).render('assets/form', formData({ ...asset, ...req.body }, '請輸入資產名稱並選擇有效的類別'));
  }

  const fields = assetFields.normalize(req.body);
  if (fields.error) return res.status(400).render('assets/form', formData({ ...asset, ...req.body }, fields.error));

  const custom = AssetField.parse(req.body, category, AssetField.currentValues(asset.id));
  if (custom.error) return res.status(400).render('assets/form', formData({ ...asset, ...req.body, tags_input: req.body.tags, tags: asset.tags }, custom.error));
  // 沒有送出 tags 欄位（例如舊的表單）就保持原本的標籤
  const tags = Object.prototype.hasOwnProperty.call(req.body, 'tags') ? AssetTag.parse(req.body.tags) : { tags: undefined, error: null };
  if (tags.error) return res.status(400).render('assets/form', formData({ ...asset, ...req.body, tags_input: req.body.tags, tags: asset.tags }, tags.error));

  const saved = Asset.update(asset.id, {
    name, category, location: cleanLocation(location), notes, ...fields.values, custom: custom.values, tags: tags.tags,
    identifier: assetFields.legacyIdentifier(req.body, asset.identifier),
    is_active: is_active === 'on' || is_active === '1',
  });

  // 有格式問題或重複時留在編輯頁讓人看到提示（已經存好了），否則回列表
  const warnings = assetFields.warningsFor(saved, Asset.findAll({ includeInactive: true }));
  res.redirect(warnings.length > 0 ? `/assets/${asset.id}/edit?saved=1` : '/assets');
});

module.exports = router;
