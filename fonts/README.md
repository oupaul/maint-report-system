# PDF 中文字型

PDF 報告功能（`src/services/PdfReportService.js`）預設字型（pdfkit 內建的 Helvetica 系列）不支援中文，若需正確顯示中文，請將支援 CJK 的字型檔置於此目錄。

**建議字型：**
- [Google Noto Sans CJK TC](https://github.com/googlefonts/noto-cjk)（思源黑體繁體中文）
- 檔名範例：`NotoSansTC-Regular.ttf`（必要）、`NotoSansTC-Bold.ttf`（選填，找不到會自動退回用 Regular 代替粗體）
- 也接受：`NotoSansCJKtc-Regular.otf` / `NotoSansCJKtc-Bold.otf`

**放置方式：**
1. 下載 Noto Sans TC 的 TTF 或 OTF 檔
2. 將字型檔複製到本專案的 `fonts/` 目錄，檔名需符合上方其中一組
3. 重新產生 PDF 報告即可正確顯示中文

若未放置字型，PDF 中的中文文字會顯示為空白或亂碼（英數字與版面配置仍正常），伺服器 log 會印出一次警告提醒，但不會導致報告產生失敗。

本目錄下的字型檔已加入 `.gitignore`（字型授權條款通常不允許隨意重新散布），需要每個部署環境自行放置。
