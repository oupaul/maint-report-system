const express = require('express');
const router = express.Router();
const BrandingService = require('../services/BrandingService');

// 瀏覽器抓分頁圖示時不一定會帶登入資訊（也包含登入頁本身），所以這幾個路由是公開的，
// 並且掛在 session 之前（抓圖示不該建立 session）。內容只是圖示本身，沒有敏感資料。
// 網址帶 ?v=<版本>：換圖示後版本變了，才能放心設長快取；/favicon.ico 沒有版本參數，快取設短一點。
function send(res, buf, type, maxAge) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

router.get('/favicon.ico', async (req, res, next) => {
  try {
    send(res, BrandingService.wrapIco(await BrandingService.getIcon('icon_32')), 'image/x-icon', 3600);
  } catch (err) {
    next(err);
  }
});

const ROUTES = { 'icon-32.png': ['icon_32'], 'icon-180.png': ['icon_180'], 'icon-256.png': ['icon_256'] };
router.get('/branding/:file', async (req, res, next) => {
  const entry = ROUTES[req.params.file];
  if (!entry) return next();
  try {
    send(res, await BrandingService.getIcon(entry[0]), 'image/png', req.query.v ? 31536000 : 3600);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
