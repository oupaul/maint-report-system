const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const InspectionBatch = require('../models/InspectionBatch');
const Asset = require('../models/Asset');
const ApprovalService = require('../services/ApprovalService');
const capacityRoutes = require('./capacity');
const issueRoutes = require('./issues');
const QuoteService = require('../services/QuoteService');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll().slice(0, 20);
  const assetCount = Asset.countActive();
  const pendingApprovals = ApprovalService.pendingFor(req.user);
  const capacityAlerts = capacityRoutes.allAttention();
  const issues = issueRoutes.summary();
  const quotes = QuoteService.dashboardFor(req.user);
  res.render('dashboard', { batches, assetCount, pendingApprovals, issues, quotes, capacityAlerts: capacityAlerts.slice(0, 5), capacityAlertTotal: capacityAlerts.length });
});

module.exports = router;
