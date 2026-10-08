const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const InspectionBatch = require('../models/InspectionBatch');
const Asset = require('../models/Asset');
const ApprovalService = require('../services/ApprovalService');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll().slice(0, 20);
  const assetCount = Asset.findAll().length;
  const pendingApprovals = ApprovalService.pendingFor(req.user);
  res.render('dashboard', { batches, assetCount, pendingApprovals });
});

module.exports = router;
