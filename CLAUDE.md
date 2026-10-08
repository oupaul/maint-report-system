# CLAUDE.md

本檔案提供 Claude Code 在此 repo 工作時的專案背景與安全邊界。

## 專案概要

Node.js + Express + SQLite（`better-sqlite3`）的 IT 例行維護巡檢紀錄與 PDF 報告系統，繁體中文介面，server-rendered（EJS，無 SPA）。正式環境透過 `deploy.sh` 產生的 systemd service 直接跑在客戶自有主機上（repo 內沒有 Dockerfile／compose.yaml；若日後導入容器化部署，比照下方「高風險操作」的謹慎程度處理）。系統管理的是巡檢紀錄與設備截圖，任何操作都應以「這是正式環境，沒有 staging」的態度對待。

## 高風險操作 — 一律先取得使用者明確同意，不自行判斷執行

維運腳本（`deploy.sh`、`update.sh`、`setup.sh`、`uninstall.sh`、`restore.sh`、`backup.sh`）本身可以視任務需要編輯，但以下操作即使看起來與當下任務相關，也必須先詢問使用者並取得明確同意才能執行（不是編輯，是「跑」）：

- **執行**上述任一維運腳本，尤其是對著真實 VM／正式主機跑
- 執行任何 migration：`npm run migrate`、`node migrations/runner.js` 或個別 migration 檔
- 操作 Docker（container/volume）、連線到正式主機／VM、直接查詢或寫入資料庫（含 `data/*.db`）
- `git commit`、`git push`，或其他會改變遠端/共享狀態的 git 操作
- 刪除或覆寫 `data/`、`uploads/`、`backups/` 底下的內容（皆為 gitignored，可能是唯一副本；`uploads/` 內是巡檢截圖，通常沒有其他備份來源）

## 密鑰與敏感設定放在哪裡

- Gitignored 設定檔：`.env`、`deploy.config.json`、`deploy.config.sh`
- `SESSION_SECRET`：`deploy.sh` 首次部署時以 `openssl rand -hex 32` 產生，寫入 `/etc/maint-report-system/session.env`（權限 600，只有服務執行帳號能讀），systemd unit 只用 `EnvironmentFile=` 引用，不會落地在 repo 內任何檔案，也不放在所有人可讀的 unit 檔案裡（舊版部署會在第一次執行新版 `deploy.sh` 時自動把既有值搬過去）；本機開發若未設定，`src/config/index.js` 會每次啟動自動產生一組亂數金鑰，代表每次重啟都會讓所有人被登出
- 本專案未安裝 `dotenv`，`.env` 不會被自動載入；`.env.example` 只是文件用範本

## 已知需要留意的技術現況（動手改 `src/` 前先確認）

- `migrations/runner.js` 的 `MIGRATIONS` 陣列只能在尾端新增，不可插入或調整既有順序；新 migration 避免對既有欄位下死值 CHECK 約束清單
- migration 檔（如 `migrate_0001_init.js`）可以是 async function（例如需要 `argon2.hash()`），`runner.js` 用手動 `BEGIN/COMMIT/ROLLBACK` 包裹每個 migration 以支援這種情況，而不是 `db.transaction()`（better-sqlite3 的 `db.transaction()` 只支援同步 callback）
- 全新安裝的 `admin` 初始密碼是 `migrations/migrate_0001_init.js` 當下產生的亂數（可用 `INITIAL_ADMIN_PASSWORD` 覆寫），`deploy.sh` 擷取 migration 輸出中 `INITIAL_ADMIN_PASSWORD_BANNER_BEGIN/END` 兩行標記之間的內容，在終端機顯示並於部署結尾再印一次（暫存檔權限 600、用完即刪）——改動 migration 的這段輸出時不要動這兩個標記，否則 `deploy.sh` 抓不到。不要把任何真實密碼寫進 commit、log 或回覆訊息；密碼強度規則在 `src/utils/password.js`，`must_change_password=1` 的帳號只能進 `/account/password` 與 `/logout`（`src/app.js`）
- 所有非 GET 請求都經過 `src/middleware/csrf.js`：一般表單帶隱藏欄位 `_csrf`；multipart 表單（巡檢項目上傳）因為 multer 解析前 body 是空的，改把 token 放 action 網址 `?_csrf=`。新增 POST 表單（或 fetch）時記得帶 token。CSP 不允許 inline script／事件處理器，確認對話框用 `data-confirm` 屬性（`public/js/confirm.js`）。HTML 不允許 `<form>` 巢狀，表單內要放獨立動作按鈕時，把表單放在外面、按鈕用 `form="id"` 屬性
- M365 SSO 是「SPA + 瀏覽器端 MSAL.js」：不使用 Client Secret，也不能改回伺服器端換 token（Azure 會把 Web 平台的 redirect 視為需要 secret）。MSAL.js 由 `/vendor/msal-browser.min.js` 從 node_modules 提供，CSP `connect-src` 需允許 `login.microsoftonline.com`；伺服器端驗證 ID token（iss/aud/exp/tid、10 分鐘 maxAge、單次使用）在 `src/services/M365AuthService.js`，改動時要保留這些檢查——ID token 是瀏覽器送來的，不可信
- `src/app.js` 每個請求都會重新讀取登入者（停用／角色變更立即生效）；`TRUST_PROXY` 環境變數預設關閉，只在確定前面有反向代理時設定，否則 `X-Forwarded-For` 可偽造來繞過登入限流
- `src/services/PdfReportService.js` 的換頁保護邏輯（估算高度 → 判斷是否 `doc.addPage()` → 才畫區塊）刻意把「估算」與「畫」分成兩步；修改任一步時要同步檢查另一步有沒有跟著失準（尤其是圖片顯示高度的估算依據是 DB 存的 `screenshot_width`/`screenshot_height`，跟畫的時候重新解碼出來的實際尺寸可能不完全一致）
- pdfkit 不支援原生畫 WebP，`PdfReportService` 無論 `screenshot_format` 是什麼都會先用 `sharp` 重新解碼成 PNG buffer 再畫；改動截圖儲存格式邏輯（`src/services/ImageService.js`）時要記得這個假設沒變
- `/uploads/:batchId/:filename` 是自訂的認證後靜態檔案服務路由（`src/routes/reports.js`），刻意不用 `express.static` 公開掛載，避免未登入使用者直接列出/存取截圖；新增檔案服務路由時比照這個模式做路徑穿越檢查

## 本機開發／測試 vs VM 測試

- 本機（`npm run dev`）：`NODE_ENV=development`、假資料、`data/maint_report.db` 可隨意重建，用來驗證功能邏輯/畫面/PDF 產生
- VM（`deploy.sh`／`update.sh`）：`NODE_ENV=production`、真實巡檢資料與截圖，沒有 staging；只有在 VM 上才能真正驗證部署腳本本身（systemd 整合、port、rsync exclude 等），但正式 VM 沒有沙盒，測部署流程優先用獨立測試 VM，不要拿正式主機當測試環境
- 完整差異表見 [`README.md`](README.md) 的「本機測試 vs VM 測試」一節

## `update.sh` / `deploy.sh` 目前的行為（供改動前參考）

沿用姊妹專案（pbg-system）驗證過的安全模式：更新前顯示明確版本來源（GitHub commit hash）、更新前要求手動確認並提醒先跑 `backup.sh`（可用 `SKIP_UPDATE_CONFIRM=1` 跳過供全自動情境使用）、`deploy.sh` 失敗會停止並印出排查方式、部署完成後呼叫 `scripts/health-check.sh` 打 `GET /login` 驗證服務真的有回應（而不是只看 `systemctl is-active`）、停服務時的 `kill -9` 只在確認佔用該 port 的程序指令包含 `app.js` 才殺、依賴安裝用 `npm ci --omit=dev`（嚴格依 package-lock.json、不裝開發用套件），之後只執行 `npm audit --omit=dev` 回報、不自動修復——依賴升級一律在開發端做完 commit 進 repo，避免主機與 GitHub 版本不一致。**沒有自動回滾**——失敗時腳本只會停下來給出資訊，不會自己嘗試修復或還原。

## Docker／Compose

Repo 目前**沒有任何 Dockerfile 或 compose.yaml**，部署完全走 systemd + VM。若有人要求「整理 Docker Compose 設定」，先確認清楚：這是要新建一套僅供本機開發/測試用的容器環境（不影響現有 systemd 部署方式），還是誤以為 repo 已經有相關設定——不要在沒問清楚的情況下憑空生出一套容器化部署。

## 常用指令

- `npm run dev` — nodemon 開發模式
- `npm start` — 正式啟動（純 `node`，不會自動 reload）
- `npm test` — jest
- `npm run migrate` — 執行 migrations/runner.js（見上方「高風險操作」，需先確認）
- `scripts/health-check.sh <PORT>` — 打 `GET /login` 驗證服務是否正常回應，`update.sh` 會自動呼叫，也可隨時手動執行
