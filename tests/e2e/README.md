# 端到端測試（E2E）

用真的瀏覽器（Chrome）操作真的伺服器，驗證「使用者實際會點到的流程」——登入、填寫、簽名、送審、刪除、匯出入、PDF 內容等。單元測試測不到的東西（CSRF、CSP、權限、前端腳本、PDF 實際產出）都在這裡。

## 它不會碰到你的資料

每次執行會在系統暫存目錄建立一份**沙盒**：複製專案原始碼（不含 `node_modules`、`data`、`uploads`、`backups`、`.git`、`docs`），全新的 SQLite 資料庫（跑完所有 migration），伺服器開在隨機 port。每個 spec 開始前資料庫與上傳目錄都會還原到乾淨狀態。**不會讀寫專案的 `data/`、`uploads/`，也不會連任何主機**，所以可以隨時在本機跑。

## 執行

需要 **Node 20**（原生套件是用 Node 20 編譯的）與本機安裝的 **Google Chrome**。

```bash
npm run test:e2e                          # 全部
npm run test:e2e -- --only deletion       # 只跑名稱含 deletion 的（可用逗號：--only customers,exports）
npm run test:e2e -- --list                # 列出所有 spec
npm run test:e2e -- --verbose             # 連通過的檢查都印出來
npm run test:e2e -- --keep                # 測完保留沙盒（排查失敗用，路徑會印出來）
```

- Chrome 找不到時用 `CHROME_PATH=/path/to/chrome` 指定；沒有 Chrome 時需要瀏覽器的 spec 會略過。
- PDF 內容檢查需要 poppler（`pdfimages`、`pdfinfo`、`pdftotext`；macOS：`brew install poppler`），沒有就略過那幾個 spec。
- 結束代碼：全部通過＝0、有失敗＝1、環境問題＝2（CI 可直接用）。
- `puppeteer-core` 25 在 `engines` 宣告需要 Node ≥ 22.12，但在 Node 20 實測可用；若 `npm install` 出現 engine 警告可忽略（它只是 devDependency，正式環境 `npm ci --omit=dev` 不會裝）。

## 目前涵蓋

| spec | 內容 |
|---|---|
| `smoke` | 主要頁面都能開、不是 500、沒有 JS 錯誤 |
| `static-assets` | 靜態檔版本碼 `?v=`、快取標頭、各頁都用 `assetUrl` |
| `combo-select` | 可搜尋下拉：點擊不展開、輸入才篩選、▾ 展開全部、清空 |
| `assets-list` | 資產列表欄位顯示／隱藏、分組、固定欄 |
| `photo-viewer` | 截圖檢視器縮放、平移、旋轉、Ctrl 滾輪 |
| `image-quality` | 上傳解析度保留（3200px）、PDF 內圖片不被縮小、附錄原圖頁、ZIP |
| `report-pdf` | 報告 PDF、選客戶的部分報告、每家一份 ZIP |
| `approval-signatures` | 送出前工程師簽名、核准前簽核人簽名（每關重簽、舊簽名／別人的不算） |
| `submit-permission` | 只有建立者與填寫者能送審／完成，管理員不是特例 |
| `login-records` | 登入紀錄、使用時間分段、閒置逾時 |
| `deletion` | 批次刪除／封存、設備移出、批次內新增的設備、設備與使用者刪除、公告、稽核紀錄 |
| `customers` | 統一編號、客戶 CSV 匯出／匯入（預覽→確認、清空語意、Big5、錯誤列）、權限 |
| `exports` | 批次清單與巡檢紀錄 CSV 匯出：篩選、容量欄位、公式防護、惡意參數 |

## 尚未涵蓋（要動到這些功能時請順手補 spec）

權限群組、資產 CSV 匯入、處理建議／分流、報價請求（含寄信）、容量趨勢預測、預設簽名、Email／M365、備份管理。

## 新增一個 spec

在 `specs/` 新增 `名稱.e2e.js`（不會被 jest 抓到），匯出：

```js
module.exports = {
  name: '顯示名稱',
  needs: ['browser'],        // 可加 'poppler'
  async run(t) {
    const admin = await t.login('admin');           // 回傳已登入的 puppeteer page
    await t.go(admin, '/batches');
    t.ok(await admin.$('h1') !== null, '有標題');   // 每個檢查一行，訊息寫「預期的行為」
  },
};
```

`lib/context.js` 的 `T` 提供常用工具：`login`、`go`、`post`、`download`、`q`／`count`（直接查沙盒資料庫）、`mkCustomer`、`mkAsset`、`mkBatch`、`mkReportBatch`、`signEngineer`、`photoJpeg`、`pdfImages`／`pdfText` 等。預設帳號：`admin`、`wang`（王小明）、`lin`（林雅婷）、`outsider`（局外人，技術人員）。每個 spec 結束時會自動多一項「頁面沒有 JavaScript 錯誤」。

注意：傳進 `page.$$eval`／`evaluate` 的函式是在**瀏覽器**執行的，看不到外層變數，要用額外參數傳進去。
