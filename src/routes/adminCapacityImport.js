const express = require('express');
const router = express.Router();

const db = require('../models/db');
const InspectionVolume = require('../models/InspectionVolume');
const capacity = require('../utils/capacity');

// 掛在 /admin/capacity-import（routes/admin.js 已限定管理員）。
// 把改成容量型之前記錄的「文字數值」盡力解析成結構化的磁碟區，讓歷史資料也能畫趨勢。
// 流程：預覽（只讀）→ 確認後才寫入。只新增磁碟區資料，不改原本的數值文字、狀態或備註；解析不了的整筆略過。
const SAMPLE_LIMIT = 200;
const UNPARSED_LIMIT = 100;

function scan() {
  const rows = db.prepare(
    `SELECT ii.id, ii.value_text, ii.batch_id, b.title AS batch_title, b.batch_date, a.name AS asset_name,
            COALESCE(ii.item_label, ci.label) AS item_label
     FROM inspection_items ii
     JOIN checklist_items ci ON ci.id = ii.checklist_item_id
     JOIN inspection_batches b ON b.id = ii.batch_id
     JOIN assets a ON a.id = ii.asset_id
     WHERE ci.input_kind = 'capacity' AND ii.value_text IS NOT NULL AND TRIM(ii.value_text) <> ''
       AND NOT EXISTS (SELECT 1 FROM inspection_item_volumes v WHERE v.inspection_item_id = ii.id)
     ORDER BY b.batch_date ASC, a.name ASC`
  ).all();
  const parsable = [];
  const unparsable = [];
  for (const r of rows) {
    const volumes = capacity.parseLegacyText(r.value_text);
    if (volumes) parsable.push({ ...r, volumes }); else unparsable.push(r);
  }
  return { parsable, unparsable };
}

function render(req, res, extra = {}) {
  const { parsable, unparsable } = scan();
  res.render('admin/capacity-import', {
    parsableCount: parsable.length,
    unparsableCount: unparsable.length,
    samples: parsable.slice(0, SAMPLE_LIMIT),
    unparsed: unparsable.slice(0, UNPARSED_LIMIT),
    sampleLimit: SAMPLE_LIMIT,
    unparsedLimit: UNPARSED_LIMIT,
    fmt: capacity,
    done: req.query.done !== undefined ? parseInt(req.query.done, 10) || 0 : null,
    ...extra,
  });
}

router.get('/', (req, res) => render(req, res));

router.post('/', (req, res) => {
  // 重新掃描一次再寫入（預覽之後資料可能又變了），只寫「現在仍然沒有磁碟區、而且能解析」的
  const { parsable } = scan();
  db.transaction(() => {
    for (const r of parsable) InspectionVolume.replaceForItem(r.id, r.volumes);
  })();
  console.log(`[容量匯入] ${req.user.username} 把 ${parsable.length} 筆舊的文字容量記錄解析成磁碟區`);
  res.redirect(`/admin/capacity-import?done=${parsable.length}`);
});

module.exports = router;
