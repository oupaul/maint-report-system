# 維護巡檢報告系統

基於 Node.js + SQLite 的 IT 例行維護巡檢紀錄與 PDF 報告系統。技術人員可記錄 PC / Server / NAS / 網路設備的硬碟健康狀態、磁碟空間、備份狀態、韌體版本等檢查項目，上傳每項檢查的截圖，並產生涵蓋整批巡檢（多台設備）的 PDF 報告。

---

## 安裝

### 一鍵安裝（從 GitHub）

> 不要寫成 `sudo bash <(curl ...)`：`<(...)` 產生的暫存檔案描述符不會傳給 sudo，會出現 `/dev/fd/63: No such file or directory`。請先下載成檔案再用 sudo 執行；也不要用 `curl ... | sudo bash`，部署過程有互動式提問，stdin 不能被腳本內容佔用。

```bash
# 公開 Repo
curl -fsSL https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh -o /tmp/setup.sh && sudo bash /tmp/setup.sh

# 私有 Repo（curl 本身也需帶 token）
export GH_TOKEN=github_pat_xxxxxxxxxxxx
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh -o /tmp/setup.sh \
  && sudo --preserve-env=GH_TOKEN bash /tmp/setup.sh
```

`setup.sh` 自動安裝 git、clone repo，並執行 `deploy.sh` 完成部署。部署前請先把 `setup.sh` / `update.sh` 裡的 `GITHUB_USER` / `GITHUB_REPO` 換成實際的 repo。

### 本機手動部署

```bash
sudo ./deploy.sh
```

首次安裝時互動式設定服務名稱、安裝目錄（預設 `/srv/apps/maint-report-system`）、port；後續執行自動增量遷移並重啟服務。

### 管理員初始帳號

全新安裝時系統會建立管理員帳號 `admin`，**密碼是安裝當下隨機產生的**，不是固定值：`deploy.sh` 會把它印在終端機視窗（migration 當下顯示一次，部署結束時再顯示一次），請立刻抄下來。第一次登入後系統會強制要求改成自己的密碼，改完才能使用其他功能。

- 忘記密碼、或沒抄到初始密碼：在主機上執行 `cd /srv/apps/maint-report-system && sudo -u <服務帳號> npm run reset-admin-password`，會產生新的隨機密碼並印出（指定其他帳號：`npm run reset-admin-password -- <帳號>`）
- 自動化部署若想自行指定初始密碼，可在執行 `deploy.sh` 前設定環境變數 `INITIAL_ADMIN_PASSWORD`（此時不會印出隨機密碼）
- 管理員在「使用者管理」新增或重設的密碼，該使用者第一次登入也必須自己再改一次；密碼至少 10 個字元、需含英文字母與數字、不可是常見密碼或包含帳號名稱
- 從舊版升級：若 `admin` 仍在使用舊版預設密碼，更新時會被自動標記為下次登入強制改密碼

### 設備類型與檢查項目（管理員）

導覽列「系統管理 → 設備類型」（`/admin/categories`）可以自訂設備有哪些類型，以及每個類型建立巡檢時要帶出哪些檢查項目（預設是 PC／Server／NAS／網路設備與原本的 11 個項目）：

- **類型**：新增、改名、調整順序、停用；新增時可以「複製檢查項目自」既有類型（例如印表機複製 NAS 再微調）。
- **檢查項目**：在類型底下新增、改名、上下移動排序、停用；也可以從其他類型整批複製。
- **用過的只能停用、不能刪除**：有設備或檢查紀錄的類型、有檢查紀錄的項目，只能停用——停用後新增設備與填寫時不再出現，但舊資料與舊報告照常顯示；從沒用過的才能刪除。
- **改項目名稱只影響之後的記錄**：已經寫好的報告維持記錄當時的項目名稱（類型名稱則同步更新，跟設備名稱一樣）。
- **已有檢查紀錄的設備不能改類型**（舊紀錄對應的是原本類型的檢查項目）。
- 進行中（草稿）的批次：新增的項目會立刻出現在填寫頁；已停用但這個批次已經填過的項目仍會顯示，不會憑空消失。
- 升級說明：第一次更新到這個版本時，系統會**先自動複製一份資料庫快照**到 `data/pre-migrate-snapshots/`（保留最近 5 份）再升級資料表結構；萬一升級失敗會完整還原，不會留下半套結構。

### 系統狀態與備份管理（管理員）

登入後管理員導覽列有兩個頁面：

- **系統狀態**（`/admin/status`）：整體健康燈號與各項檢查（資料庫、資料／備份磁碟空間、備份是否按時完成、系統記憶體）、**目前線上使用者**（5 分鐘內有操作；顯示來源 IP、裝置、最後操作時間）、最近登入、服務與主機資訊、儲存空間用量、資料筆數；另有按鈕可手動執行資料庫完整性檢查。每 30 秒自動更新。線上使用者只存在記憶體，服務重啟後清空。
- **備份管理**（`/admin/backups`）：自動備份排程（每天／每週、時間、保留天數）、立即備份、備份檔清單（下載／刪除）、最近一次備份結果。
  - **預設就是啟用：每天 02:00（台北時間），保留 14 天**；服務在備份時間停機或重啟，啟動後會自動補跑。
  - 備份用 SQLite 線上備份取得一致的資料庫快照，再連同 `uploads/` 打包成 `backup_YYYYMMDD_HHMMSS.tar.gz`，格式與 `backup.sh` 相同，**可直接用 `restore.sh` 還原**；備份完成會自動驗證（資料庫完整性、壓縮檔內容），磁碟空間不足時不會開始備份。
  - 還原**不開放在網頁上**（會覆蓋正在使用的資料庫），請在主機上執行 `restore.sh`。備份檔含完整資料庫與截圖，建議定期另存到別台主機或 NAS。
  - 如果之前用 `setup-backup-timer.sh` 設定過 systemd 計時器，兩者會並存（多產生備份而已）；改用網頁排程後可以用 `setup-backup-timer.sh` 選「停用」關掉舊的。
- 外部監控（Uptime Kuma、Cloudflare Health Check 等）可以打 `GET /healthz`：不需登入，正常回 `200 {"status":"ok"}`，資料庫不可用回 `503`，不洩漏其他資訊。

### 自訂瀏覽器分頁圖示（管理員）

導覽列「外觀設定」（`/admin/branding`）可以上傳自己的分頁圖示（favicon）：支援 PNG / JPEG / WebP / GIF，上限 2MB，建議 256×256 以上、背景透明的正方形 PNG。系統會自動產生 32／180／256 像素的版本與真正的 `favicon.ico`，套用到所有頁面（含登入頁），手機加到主畫面時也會用同一張圖。非正方形的圖會完整保留、不裁切。沒有上傳時使用內建的預設圖示，可隨時一鍵還原。圖示存在資料庫裡，所以備份與還原都會一併帶走。不接受 SVG（可能夾帶腳本）。

### 圖片上傳

巡檢截圖上傳後一律轉成 WebP（依 EXIF 轉正、長邊縮到 2000px 以內、品質 82），單張上限 10MB、一次最多 10 張。iPhone 的 HEIC 格式不支援（伺服器端沒有 HEVC 解碼器），上傳時會提示改用「最相容」格式或先轉成 JPEG；檔案毀損或不是真的圖片會明確拒絕並指出是哪一個檔案。截圖需登入才能瀏覽。

**檢視截圖**（填寫頁與批次摘要頁）：點縮圖或「查看」會**就地展開**深色檢視區（不開新視窗，不會被瀏覽器的快顯封鎖擋下），可「向左／向右旋轉」（手機拍的照片方向不對時自己轉正看，只影響畫面、不改檔案）、「上一張／下一張」（同一檢查項目有多張時，也可用鍵盤 ←／→）、「收合」（或按 Esc、或再點一次同一張）。

### 安全機制摘要

- 登入失敗限流：同一 IP 或同一帳號短時間內失敗過多次會暫時鎖定 15 分鐘
- 所有 POST 表單都有 CSRF token；Cookie 為 `HttpOnly` + `SameSite=Lax`（HTTPS 時自動加 `Secure`）；Session 存在 SQLite，服務重啟不會被登出；帳號被停用、角色調整會立即生效
- 瀏覽器端有 CSP 等安全標頭（不允許 inline script）
- 若前面架了反向代理（nginx/Caddy、**Cloudflare Tunnel** 等）才需設定環境變數 `TRUST_PROXY=1`，讓系統看得到真實用戶 IP 與 HTTPS 狀態（Cookie 才會加 `Secure`）；沒設的話所有人在系統眼中都來自 `127.0.0.1`，登入失敗限流會變成「全部使用者共用同一個額度」。設定方式：在 `/etc/maint-report-system/session.env` 加一行 `TRUST_PROXY=1` 後 `sudo systemctl restart maint-report-system`（這個檔案更新時不會被覆蓋）。直接以 IP:port 存取請保持不設定，否則登入限流可被偽造的 `X-Forwarded-For` 繞過
- 經由 Cloudflare 時請確認：該網址沒有被快取（Cache Rules 不要涵蓋 `/login`、`/auth/*`），且沒有開啟 Rocket Loader（會改寫頁面上的 script 載入方式，可能讓登入頁的 MSAL.js 失效）

### 環境變數（進階，選填）

透過 `setup.sh`／`deploy.sh` 部署不需要處理這一步（`SESSION_SECRET` 會自動產生）。若要用 `npm run dev` 或手動啟動，可參考 [`.env.example`](.env.example) 設定 `PORT`、`NODE_ENV`、`SESSION_SECRET` 等變數（本專案未使用 dotenv，需自行 `export`）。

---

## 更新

```bash
# 從安裝目錄執行（最常用）
sudo /srv/apps/maint-report-system/update.sh

# 或遠端一行指令
export GH_TOKEN=github_pat_xxxxxxxxxxxx
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/oupaul/maint-report-system/main/update.sh -o /tmp/update.sh \
  && sudo --preserve-env=GH_TOKEN bash /tmp/update.sh
```

`update.sh` 自動偵測安裝目錄、rsync 同步程式碼（保留 `data/`、`uploads/`），再執行增量 migration。執行前會顯示目前／最新版本與 commit hash，並要求手動確認（建議先執行一次 `backup.sh`）；部署完成後會自動跑健康檢查（`scripts/health-check.sh`），若 migration 或健康檢查失敗會停止並印出排查方式，不會自動重試或回滾。全自動情境可設定 `SKIP_UPDATE_CONFIRM=1` 跳過確認步驟。

---

## 本機測試 vs VM 測試

| | 本機（`npm run dev`） | VM（`deploy.sh`／`update.sh`） |
|---|---|---|
| 執行環境 | `NODE_ENV=development` | `NODE_ENV=production`，寫進 systemd unit |
| 資料 | 本機 `data/maint_report.db`，可隨時砍掉重建 | 真實巡檢資料，沒有 staging 環境 |
| `SESSION_SECRET` | 未設定的話每次啟動都換一組 | 首次部署自動產生，存放於 `/etc/maint-report-system/session.env`（權限 600），systemd unit 以 `EnvironmentFile=` 引用 |
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

## Microsoft 365 SSO（選用）

登入頁可以顯示「使用 Microsoft 365 登入」按鈕，讓使用者用組織的 M365/Azure AD（Entra ID）帳號登入，不用額外記密碼。**帳號密碼登入永遠保留作為備用方式**，兩種方式並存。

### 運作方式（不需要 Client Secret）

與 expense-platform 相同：Azure 端登錄為「**單頁應用程式（SPA）**」，由**瀏覽器**上的 MSAL.js 以 Authorization Code + PKCE 登入，登入完成後把 Microsoft 核發的 ID token 交給伺服器；伺服器用 Microsoft 的公開金鑰驗證簽章，並檢查發行者（租戶）、受眾（Client ID）、有效期限（只收 10 分鐘內簽發的），同一張 token 只能使用一次。主機上沒有任何 M365 機密，Client ID／Tenant ID 也不是機密。

### 第 1 步：在 Azure Portal 建立 App Registration（需要 Azure/M365 系統管理員權限）

1. 登入 [Azure Portal](https://portal.azure.com) → 搜尋「Microsoft Entra ID」→ 左側選單「App registrations」→「New registration」
2. 名稱隨意（例如「維護巡檢報告系統」），「Supported account types」選你們組織內部使用即可（單一租戶：`Accounts in this organizational directory only`）
3. 「Redirect URI」平台選 **Single-page application（SPA）**，填：`https://<網域>/auth/m365/callback`。**必須是 HTTPS**（Microsoft 只接受 `https://`，唯一例外是 `http://localhost`；瀏覽器端的 MSAL.js 也只能在 HTTPS 或 localhost 下運作），用 IP:port 直連的純 HTTP 部署請先在前面加反向代理（nginx/Caddy）並設定 HTTPS，同時依[安全機制摘要](#安全機制摘要)設定 `TRUST_PROXY`
4. 建立完成後，在「Overview」頁記下：
   - **Application (client) ID** → 對應 `M365_CLIENT_ID`
   - **Directory (tenant) ID** → 對應 `M365_TENANT_ID`（請填 GUID，不要填網域名稱）
5. **不需要建立 client secret**，也不用調整「Allow public client flows」；已經建過 secret 的可以到「Certificates & secrets」刪除
6. 左側選單「API permissions」，預設應該已經有 `User.Read`（Microsoft Graph, Delegated），不用額外設定；本系統只用來確認登入者身分，不會存取信箱、檔案等其他資料

### 第 2 步：在主機上填入設定值

`deploy.sh` 會自動建立 `/etc/maint-report-system/m365.env`（權限鎖為 `600`，只有服務執行帳號能讀取）並讓 systemd unit 引用它，**不需要手動跑 `systemctl edit`**。這個檔案權限鎖死（`600`），設定值不會出現在所有本機帳號都能讀的 unit 檔案（`644`）裡；只有 Client ID／Tenant ID／Redirect URI 三個值，不含任何金鑰。

跑過一次 `setup.sh`／`deploy.sh`／`update.sh` 之後（沒設定 M365 也沒關係，這個檔案一律會建立），編輯這個檔案填入第 1 步記下的值：

```bash
sudo nano /etc/maint-report-system/m365.env
```

把範本裡對應的三行取消註解並填值：
（從舊版升級、檔案裡還有 `M365_CLIENT_SECRET=` 的，請刪掉那一行——現在會被忽略。另外 Azure 的 Redirect URI 要登錄在 **SPA** 平台底下，不是 Web。）

```
M365_CLIENT_ID=你的Client-ID
M365_TENANT_ID=你的Tenant-ID
M365_REDIRECT_URI=https://<網域>/auth/m365/callback
```

存檔後重啟服務：

```bash
sudo systemctl restart maint-report-system
```

`update.sh`／`deploy.sh` 都不會覆蓋這個檔案的內容（只在檔案不存在時建立空白範本）。

### 第 3 步：幫使用者開通 SSO 登入

系統**不會**讓任何能登入你們 M365 租戶的人自動取得帳號——管理員需要先在「使用者管理」建立好帳號（或編輯既有帳號），在「M365 Email」欄位填入該使用者的 M365 登入信箱，存檔後這個人就能用「使用 Microsoft 365 登入」進來，登入後對應到這個帳號的角色與權限。未被登記 M365 Email 的人即使能登入你們的 M365 租戶，也會被系統拒絕並提示「尚未被加入系統」。

---

## 系統需求

- Ubuntu 24.04 LTS（推薦）或其他 Linux
- Node.js 20.x
- 記憶體 512MB 以上、硬碟 1GB 以上

---

## 授權

Copyright (C) 2026 OU SHOU SHUO

本專案採用 **GNU Affero General Public License v3.0（AGPL-3.0）** 授權，完整條款見 [LICENSE](LICENSE)。

AGPL-3.0 與一般 GPL 最大的差別在第 13 條：如果你修改了本專案並讓使用者**透過網路**與它互動（例如部署成內部或對外的網站），必須向這些使用者提供修改後版本的完整原始碼。單純自己內部使用、沒有修改，則不受此限。

第三方元件各自適用其原本的授權：

- `fonts/NotoSansTC-*.otf`（思源黑體繁體中文）：SIL Open Font License 1.1，授權全文見 [fonts/OFL.txt](fonts/OFL.txt)
- `node_modules/` 內的 npm 套件：各自的授權條款
