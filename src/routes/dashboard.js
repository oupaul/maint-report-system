const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const InspectionBatch = require('../models/InspectionBatch');
const Asset = require('../models/Asset');
const ApprovalService = require('../services/ApprovalService');
const capacityRoutes = require('./capacity');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll().slice(0, 20);
  const assetCount = Asset.countActive();
  const pendingApprovals = ApprovalService.pendingFor(req.user);
  const capacityAlerts = capacityRoutes.allAttention();
  res.render('dashboard', { batches, assetCount, pendingApprovals, capacityAlerts: capacityAlerts.slice(0, 5), capacityAlertTotal: capacityAlerts.length });
});

module.exports = router;
