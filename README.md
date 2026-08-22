# 維護巡檢報告系統

基於 Node.js + SQLite 的 IT 例行維護巡檢紀錄與 PDF 報告系統。技術人員可記錄 PC / Server / NAS / 網路設備的硬碟健康狀態、磁碟空間、備份狀態、韌體版本等檢查項目，上傳每項檢查的截圖，並產生涵蓋整批巡檢（多台設備）的 PDF 報告。

---

## 安裝

### 一鍵安裝（從 GitHub）

```bash
# 公開 Repo
bash <(curl -fsSL https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh)

# 私有 Repo（curl 本身也需帶 token）
export GH_TOKEN=github_pat_xxxxxxxxxxxx
bash <(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh)
```

`setup.sh` 自動安裝 git、clone repo，並執行 `deploy.sh` 完成部署。部署前請先把 `setup.sh` / `update.sh` 裡的 `GITHUB_USER` / `GITHUB_REPO` 換成實際的 repo。

### 本機手動部署

```bash
sudo ./deploy.sh
```

首次安裝時互動式設定服務名稱、安裝目錄（預設 `/srv/apps/maint-report-system`）、port；後續執行自動增量遷移並重啟服務。

### 預設帳號

| 帳號    | 密碼       |
|---------|------------|
| `admin` | `admin123` |

**首次登入後請立即變更密碼。**

### 環境變數（進階，選填）

透過 `setup.sh`／`deploy.sh` 部署不需要處理這一步（`SESSION_SECRET` 會自動產生）。若要用 `npm run dev` 或手動啟動，可參考 [`.env.example`](.env.example) 設定 `PORT`、`NODE_ENV`、`SESSION_SECRET` 等變數（本專案未使用 dotenv，需自行 `export`）。

---

## 更新

```bash
# 從安裝目錄執行（最常用）
sudo /srv/apps/maint-report-system/update.sh

# 或遠端一行指令
export GH_TOKEN=github_pat_xxxxxxxxxxxx
bash <(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/oupaul/maint-report-system/main/update.sh)
```

`update.sh` 自動偵測安裝目錄、rsync 同步程式碼（保留 `data/`、`uploads/`），再執行增量 migration。執行前會顯示目前／最新版本與 commit hash，並要求手動確認（建議先執行一次 `backup.sh`）；部署完成後會自動跑健康檢查（`scripts/health-check.sh`），若 migration 或健康檢查失敗會停止並印出排查方式，不會自動重試或回滾。全自動情境可設定 `SKIP_UPDATE_CONFIRM=1` 跳過確認步驟。

---

## 本機測試 vs VM 測試

| | 本機（`npm run dev`） | VM（`deploy.sh`／`update.sh`） |
|---|---|---|
| 執行環境 | `NODE_ENV=development` | `NODE_ENV=production`，寫進 systemd unit |
| 資料 | 本機 `data/maint_report.db`，可隨時砍掉重建 | 真實巡檢資料，沒有 staging 環境 |
| `SESSION_SECRET` | 未設定的話每次啟動都換一組 | 首次部署自動產生並固定寫入 systemd unit |
| 啟動方式 | 手動 `npm run dev` | 透過 systemd 服務常駐、`Restart=always` |
| 適合驗證什麼 | 功能邏輯、畫面、UI 互動、PDF 產生邏輯 | 部署腳本本身、systemd 整合、實際 port 設定是否正確 |

驗證 `update.sh`／`deploy.sh` 這類部署腳本的行為，本機跑不出來（沒有 systemd、沒有真實安裝目錄結構），必須在 VM 上測試。一般功能開發／改 bug，優先用本機 `npm run dev` 驗證，不需要動到 VM。

---

## 備份

### 手動備份

```bash
sudo /srv/apps/maint-report-system/backup.sh
```

### 設定自動備份排程

```bash
sudo /srv/apps/maint-report-system/setup-backup-timer.sh
```

設定 Systemd Timer，每日自動備份至本機 `backups/` 目錄（資料庫 + `uploads/` 截圖）。

---

## 還原

```bash
sudo /srv/apps/maint-report-system/restore.sh
```

互動式選擇備份檔，自動停止服務、還原資料庫與截圖、重啟。

---

## 腳本一覽

| 腳本                    | 用途                                   |
|-------------------------|----------------------------------------|
| `setup.sh`              | 全新主機一鍵安裝（從 GitHub）          |
| `update.sh`             | 更新現有安裝至最新版本                 |
| `deploy.sh`             | 本機部署（首次安裝 / 增量更新）        |
| `backup.sh`             | 手動備份（資料庫 + 截圖）              |
| `restore.sh`            | 還原備份                               |
| `setup-backup-timer.sh` | 設定 Systemd Timer 自動備份排程        |
| `uninstall.sh`          | 移除系統（自動備份後再刪除）           |
| `scripts/health-check.sh` | 部署後／手動健康檢查（`update.sh` 會自動呼叫） |

---

## 資料模型概要

- `users`：使用者帳號（admin / technician 兩種角色）
- `assets`：受管資產（pc / server / nas / network_device）
- `checklist_items`：各資產類別的檢查項目清單（種子資料，見 `migrations/migrate_0001_init.js`）
- `inspection_batches`：一次巡檢批次（可涵蓋多台設備），draft → completed
- `inspection_batch_assets`：批次涵蓋哪些資產
- `inspection_items`：每個資產 × 檢查項目的實際紀錄（狀態、數值、備註、截圖）

## PDF 報告產生邏輯

`src/services/PdfReportService.js` 依資產分組畫出整批巡檢報告。每個檢查項目（`inspection_items`）視為不可分頁區塊：畫之前先估算所需高度，若剩餘頁面空間不足就主動換頁，避免同一個檢查項目的標籤、數值、截圖被硬切成兩頁。pdfkit 原生不支援 WebP，因此不論截圖實際儲存格式為何，畫入 PDF 前一律用 `sharp` 重新解碼成 PNG buffer；解碼失敗時該筆改印「圖片無法顯示」文字，不會讓整份報告產生失敗。

---

## 系統需求

- Ubuntu 24.04 LTS（推薦）或其他 Linux
- Node.js 20.x
- 記憶體 512MB 以上、硬碟 1GB 以上
