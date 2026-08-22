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
- `SESSION_SECRET`：`deploy.sh` 首次部署時以 `openssl rand -hex 32` 產生，直接寫入 systemd unit 的 `Environment=`，不會落地在 repo 內任何檔案；本機開發若未設定，`src/config/index.js` 會每次啟動自動產生一組亂數金鑰，代表每次重啟都會讓所有人被登出
- 本專案未安裝 `dotenv`，`.env` 不會被自動載入；`.env.example` 只是文件用範本

## 已知需要留意的技術現況（動手改 `src/` 前先確認）

- `migrations/runner.js` 的 `MIGRATIONS` 陣列只能在尾端新增，不可插入或調整既有順序；新 migration 避免對既有欄位下死值 CHECK 約束清單
- migration 檔（如 `migrate_0001_init.js`）可以是 async function（例如需要 `argon2.hash()`），`runner.js` 用手動 `BEGIN/COMMIT/ROLLBACK` 包裹每個 migration 以支援這種情況，而不是 `db.transaction()`（better-sqlite3 的 `db.transaction()` 只支援同步 callback）
- 全新安裝的預設帳號是 `admin`/`admin123`（`migrations/migrate_0001_init.js`）；文件或範例中提到帳密時務必用假資料，不要把任何真實部署的憑證寫進 commit 或訊息
- `src/services/PdfReportService.js` 的換頁保護邏輯（估算高度 → 判斷是否 `doc.addPage()` → 才畫區塊）刻意把「估算」與「畫」分成兩步；修改任一步時要同步檢查另一步有沒有跟著失準（尤其是圖片顯示高度的估算依據是 DB 存的 `screenshot_width`/`screenshot_height`，跟畫的時候重新解碼出來的實際尺寸可能不完全一致）
- pdfkit 不支援原生畫 WebP，`PdfReportService` 無論 `screenshot_format` 是什麼都會先用 `sharp` 重新解碼成 PNG buffer 再畫；改動截圖儲存格式邏輯（`src/services/ImageService.js`）時要記得這個假設沒變
- `/uploads/:batchId/:filename` 是自訂的認證後靜態檔案服務路由（`src/routes/reports.js`），刻意不用 `express.static` 公開掛載，避免未登入使用者直接列出/存取截圖；新增檔案服務路由時比照這個模式做路徑穿越檢查

## 本機開發／測試 vs VM 測試

- 本機（`npm run dev`）：`NODE_ENV=development`、假資料、`data/maint_report.db` 可隨意重建，用來驗證功能邏輯/畫面/PDF 產生
- VM（`deploy.sh`／`update.sh`）：`NODE_ENV=production`、真實巡檢資料與截圖，沒有 staging；只有在 VM 上才能真正驗證部署腳本本身（systemd 整合、port、rsync exclude 等），但正式 VM 沒有沙盒，測部署流程優先用獨立測試 VM，不要拿正式主機當測試環境
- 完整差異表見 [`README.md`](README.md) 的「本機測試 vs VM 測試」一節

## `update.sh` / `deploy.sh` 目前的行為（供改動前參考）

沿用姊妹專案（pbg-system）驗證過的安全模式：更新前顯示明確版本來源（GitHub commit hash）、更新前要求手動確認並提醒先跑 `backup.sh`（可用 `SKIP_UPDATE_CONFIRM=1` 跳過供全自動情境使用）、`deploy.sh` 失敗會停止並印出排查方式、部署完成後呼叫 `scripts/health-check.sh` 打 `GET /login` 驗證服務真的有回應（而不是只看 `systemctl is-active`）、停服務時的 `kill -9` 只在確認佔用該 port 的程序指令包含 `app.js` 才殺、`npm audit fix`（不含 `--force`）預設每次部署自動執行（可用 `SKIP_AUDIT_FIX=1` 跳過）。**沒有自動回滾**——失敗時腳本只會停下來給出資訊，不會自己嘗試修復或還原。

## Docker／Compose

Repo 目前**沒有任何 Dockerfile 或 compose.yaml**，部署完全走 systemd + VM。若有人要求「整理 Docker Compose 設定」，先確認清楚：這是要新建一套僅供本機開發/測試用的容器環境（不影響現有 systemd 部署方式），還是誤以為 repo 已經有相關設定——不要在沒問清楚的情況下憑空生出一套容器化部署。

## 常用指令

- `npm run dev` — nodemon 開發模式
- `npm start` — 正式啟動（純 `node`，不會自動 reload）
- `npm test` — jest
- `npm run migrate` — 執行 migrations/runner.js（見上方「高風險操作」，需先確認）
- `scripts/health-check.sh <PORT>` — 打 `GET /login` 驗證服務是否正常回應，`update.sh` 會自動呼叫，也可隨時手動執行
