const express = require('express');
const router = express.Router();

const { requireLogin } = require('../middleware/auth');
const InspectionBatch = require('../models/InspectionBatch');
const Asset = require('../models/Asset');

router.get('/', requireLogin, (req, res) => {
  const batches = InspectionBatch.findAll().slice(0, 20);
  const assetCount = Asset.findAll().length;
  res.render('dashboard', { batches, assetCount });
});

module.exports = router;
