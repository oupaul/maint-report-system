# PDF 中文字型

PDF 報告功能（`src/services/PdfReportService.js`）需要支援 CJK 的字型才能正確顯示中文，pdfkit 內建的 Helvetica 系列不支援。

**本專案預設已內建** [Google Noto Sans TC](https://github.com/notofonts/noto-cjk)（思源黑體繁體中文，`NotoSansTC-Regular.otf` / `NotoSansTC-Bold.otf`），隨 repo 一起 clone/更新，不需要額外下載或手動放置，`update.sh` 也不會刪除它。授權條款見 `OFL.txt`（SIL Open Font License 1.1，明文允許隨軟體重新發布/內嵌，此為官方發行的原始字型檔，未經修改）。

**若要改用其他字型**：把字型檔（`.ttf` / `.otf`，需支援中文字符集）放到本目錄，檔名符合下列其中一組，`PdfReportService.js` 會優先採用（找不到才退回內建的 Noto Sans TC）：

- `NotoSansTC-Regular.ttf` / `NotoSansTC-Bold.ttf`
- `NotoSansCJKtc-Regular.otf` / `NotoSansCJKtc-Bold.otf`

若換成非 OFL 或其他不允許自由重新散布的授權字型，記得自行把該檔名加回 `.gitignore`，避免不小心 commit 進 repo。
