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
- **系統通知／橫幅**（`models/Announcement.js`、`routes/adminAnnouncements.js`、`public/js/notifications.js`）：橫幅內容一律以 `textContent`／EJS 跳脫輸出（訊息是管理員輸入的純文字，不可改成 `innerHTML`）；前端每 20 秒輪詢 `GET /notifications/status`（未讀數＋有效橫幅）。管理頁**刻意不放在會自動重新整理的「系統狀態」頁**（`<meta refresh>` 會洗掉輸入到一半的訊息）；任何有輸入欄位的頁面都不要設 `refreshSeconds`
- **填寫頁就地儲存**（`public/js/entry-save.js`、`utils/ajax.js`、`partials/entry-photo-*.ejs`）：背景請求帶 `X-Requested-With: fetch`，`isAjax(req)` 為真時，錯誤一律回 JSON（`sendError`、全域錯誤處理、CSRF、登入檢查都支援），成功時 `rowPayload` 回傳該列的狀態與**伺服器用同一份 partial 渲染的**縮圖區／刪除表單 HTML，前端直接換上去。新增會修改這個畫面的路由要同時支援一般表單送出（redirect 並帶 `#row-a<資產>-c<項目>` 錨點）與背景請求。**CSRF 驗證在 multer 之前**：multipart 要把 token 放網址 `?_csrf=`；沒有檔案的背景請求用 urlencoded 送（`FormData` 會變 multipart，token 讀不到）。刪除截圖會驗證該截圖屬於這個批次。**貼上／拖曳的截圖**只存在瀏覽器記憶體（`row._pending`），儲存時才以 `FormData` 的 `screenshots` 欄位一起送出（與選檔上傳同一條伺服器路徑，沒有新的上傳端點）；**「儲存全部」固定在畫面底部**（`position: fixed`，不可改回 in-flow／sticky，否則出現/消失會推動頁面、造成捲動位置跳動），**依序**（不平行）儲存各列，`save(form)` 回傳 Promise。伺服器的單項儲存路由對每張圖獨立處理、全部嘗試完才回報失敗清單（`savedPartial`）。送出審核／完成／新增設備的表單（action 結尾 `/submit`、`/complete`、`/assets`）有未儲存列時由 `entry-save.js` 攔截並詢問，新增類似會離開頁面的表單時要一併考慮
- **資產識別欄位**（migration 0013、`utils/assetFields.js`）：`assets` 有 `ip_address`／`mac_address`／`hostname`／`serial_number`／`asset_tag`／`brand`／`model`／`purchase_date`（YYYY-MM-DD 字串）八個選填欄位，欄位清單與檢查規則集中在 `FIELDS`；舊的 `identifier` 欄位**不可再新增內容**，只在表單有送出時才更新（`legacyIdentifier`：沒這個欄位的表單要保留原值），用來讓管理員整理無法自動判斷的舊資料。IP、MAC 允許多個（逗號分隔），IP 以 `net.isIP` 檢查，MAC 統一存大寫加冒號（`formatMac`）；格式問題與重複**只提示不擋存檔**（編輯頁每次顯示都即時計算 `warningsFor`）。新增會顯示／搜尋資產識別資訊的地方，請用這些欄位（`Asset.search` 的 `SEARCH_COLUMNS` 是搜尋欄位清單），不要再用 `identifier`
- **客戶**（migration 0022、`models/Customer.js`、`/admin/customers`、權限 `assets.manage`）：`assets.customer_id` 決定設備屬於哪家客戶；**巡檢批次不存客戶，客戶由批次涵蓋的設備決定（一個批次可以有多家客戶）**，所以不要在批次上加 customer 欄位或限制同批次只能一家。`Asset.enrich` 會補 `customer_name`，`InspectionBatch.getAssets` 依「客戶（未指定排最後）→ 類型 → 名稱」排序（填寫頁、摘要頁、PDF 共用這個順序，標題在客戶換了時插入）。新增設備（表單、批次的快速新增列）在有啟用中客戶時必須選客戶（`parseCustomer`／`parseQuickAssets`），編輯舊設備與 CSV 匯入只提醒不強制。`Asset.update` 的 `customer_id`：undefined＝不動、null＝清除。報價請求快照存 `customerName`。客戶停用後仍保留在既有設備上（`Customer.selectable(current)`）
- **處理建議／分流**（migration 0021、`models/IssueTriage.js`、`/issues/triage`）：`issue_triage` 以 (asset_id, checklist_item_id) 為鍵（跟著項目、不是某次巡檢），`IssueTriage.evaluate` 是「這筆分流現在還有沒有效」的唯一判斷（惡化、複查到期、排程逾期、已處理後仍異常、前一輪問題的分流＝失效並回傳重新浮出的原因），`OpenIssues.loadAll` 與 `IssueTriage.activeFor` 都用它，**不要在別處另寫一套**。報價規則在 `QuoteService.quoteAllowance`：異常永遠可送；警告要有效的「需要報價」分流，或管理員開了 `allow_warning_direct`；`create` 會在伺服器端檢查，建立成功會把這些項目標成「需要報價」。系統建議 `OpenIssues` 的 `buildHint` 只是提示文字，不影響任何權限或流程
- **報價請求**（migration 0019、`services/QuoteService.js`、`QuotePdfService.js`、`routes/quotes.js`、`adminQuotes.js`）：請求內容是送出當下的**快照**（設備資料 JSON、項目文字、截圖複製到 `uploads/quotes/<id>/`），不要改成即時關聯原項目；狀態機在 `QuoteService`（pending_confirm→sent→processing→quoted→closed，cancelled），狀態轉換一律走 `transition()`（交易內重讀再改）並檢查權限；同一「設備＋檢查項目」不能有兩張進行中的請求。收通知的人＝設定頁指定群組（`quote_settings.notify_group_id`，migration 0020，需有 `quotes.receive`）的啟用中成員（`salesRecipients`；沒指定＝所有有此權限的群組），**不會自動加管理員、也沒有「沒人就通知管理員」的退路**——沒人時請求照建、時間軸記警告。管理員靠 `can()` 永遠能看／處理全部請求。**通知業務走專用路徑**（站內通知不呼叫 `queueNotificationEmail`，改由 `queueRichEmails` 寄一封附 PDF 的信並把結果寫回通知與時間軸，避免重複寄信）；寄信失敗不影響請求本身。`notifications.link` 讓通知可以指到任意站內頁（`safeReturnPath` 驗證）。**render 時別把區域變數命名為 `can`**（會蓋掉 layout 的全域 `can()`，整頁 500）。自動提醒 `runReminders` 由 `startReminders` 每小時跑一次（app.js 啟動時註冊）。業務可見的設備欄位以**顯示當下**的設定過濾（`QuotePdfService.visibleAssetLines`），快照裡存全部
- **待處理項目**（`models/OpenIssues.js`、`routes/issues.js`、`/issues`）：用 `ROW_NUMBER() OVER (PARTITION BY asset_id, checklist_item_id ORDER BY batch_date DESC, batch_id DESC)` 取每個「設備＋檢查項目」**最新一次**的記錄，是 warning/critical 才算（含草稿批次、不含停用設備）；連續次數是往前連續非 normal 的次數；容量型項目要 `InspectionVolume.attach`（已做）。批次摘要頁每個檢查項目那一列有 `id="item-<inspection_items.id>"` 錨點（`/issues` 與儀表板的深層連結靠它，改摘要頁表格時不要拿掉），高亮用 CSS `:target`。篩選在記憶體做（待處理量不大），參數一律夾在合法範圍
- **資產 CSV 匯出／匯入**（`services/AssetCsvService.js`、`utils/csv.js`、`routes/assets.js` 的 `/export.csv`、`/import*`）：匯入分「規劃 `plan`（只讀，產生每列結果與差異）→ 套用 `apply`（單一交易，只寫有效列）」，預覽與確認之間的資料放記憶體（30 分鐘、每人一份），**確認時用保存的原始資料重新規劃**（預覽後資料可能又變了），不要改成直接套用預覽結果。語意：有 `資產ID`＝更新、沒有＝新增（同名同類別擋下）；**欄位存在但空白＝清空、欄位整欄不存在＝不動**，預覽要明確標出每個清空；驗證全部沿用 `assetFields.normalize`／`AssetField.parse`／`AssetTag.parse`（不要另寫一套規則）。大量比對重複用 `assetFields.buildDuplicateIndex`（逐列掃全部設備會很慢）。匯出的儲存格開頭是 `= + - @` 要補單引號、匯入用 `stripFormulaGuard` 拿掉（兩邊要成對）；上傳是 multipart，CSRF token 在網址 `?_csrf=`。新增匯出欄位時，`FIXED`（順序＝匯出順序）、`plan`、`apply` 要一起改，並確保「匯出 → 匯入」仍是全部無變更
- **容量型檢查項目**（migration 0018、`utils/capacity.js`、`models/InspectionVolume.js`、`routes/capacity.js`）：`checklist_items.input_kind` 為 `capacity` 的項目，填寫頁用磁碟區編輯區（`partials/entry-volumes.ejs` + `public/js/capacity-editor.js`），資料存 `inspection_item_volumes`（**容量一律 GB**，總容量＝已用＋剩餘），`inspection_items.value_text` 由 `capacity.summaryText` 自動產生（沒填磁碟區就保留原文字）；表單用 `vol_present=1` 表示「這次有送出編輯區」（空列表＝清空磁碟區），解析與驗證只放在 `capacity.parseVolumes`。**取檢查紀錄給畫面／報告用時要 `InspectionVolume.attach(items)`**（摘要頁與 PDF 路由已做，`PdfReportService.valueTextOf` 是估算高度與繪製共用的文字來源，兩邊要一起改）。趨勢預測 `capacity.forecast` 只用「最近一次擴充容量之後」的點、至少 3 筆且跨 28 天，資料不足就不預測（不要放寬成亂猜）。就地儲存回傳的 `volumesHtml` 只在使用者儲存期間沒再改這一列時才換進畫面。舊文字解析（`parseLegacyText`）寧可略過不猜，匯入只新增磁碟區、不動原文字。CSV 匯出的儲存格開頭是 `= + - @` 要補單引號（防 CSV injection）
- **預設簽名**（migration 0017、`models/UserSignature.js`、`routes/account.js` 的 `/account/signature.png`）：一人一筆、PNG 存 BLOB，**只有本人能取用**（沒有任何依 id 取別人簽名的網址，不要新增）；儲存時一律用 `sharp` 實際解碼、縮圖後重新編碼，簽名 POST（`/batches/:id/signatures/:role`）也會先解碼確認是 PNG 才寫檔。「使用這個簽名」只是前端把圖畫進畫布，送出仍走同一條簽名流程（簽署人一律是目前登入帳號），已簽的批次簽名是獨立檔案，刪除或更換預設簽名不影響它們
- **資產標籤、位置與列表**（migration 0016、`models/AssetTag.js`）：標籤是自由輸入（逗號分隔）、名稱不分大小寫唯一，儲存設備時自動建立、沒有設備在用就自動刪除（`AssetTag.setForAsset` 在 `Asset.create/update` 的交易裡）；`Asset.query` 是資產管理頁唯一的搜尋／篩選／排序／分頁入口，**排序欄位只能是 `SORT_COLUMNS` 白名單**（不要把使用者輸入拼進 SQL），分頁參數都要夾在合法範圍。取設備的方法一律經過 `enrich`（補自訂欄位值與標籤）。導覽列「系統管理」選單只給管理員，只有 `categories.manage` 權限的人看到的是獨立的「設備設定」選單（`views/layout.ejs`）；權限群組頁可直接加入／移出成員（`PermissionGroup.addMembers/removeMember`，只收啟用中的非管理員，一人只屬於一個群組）。migration 0015 只修還是出廠預設的「設備管理員」群組（補 `assets.manage`），不要擴大這個修正的範圍
- **自訂資產欄位**（migration 0014、`models/AssetField.js`、`routes/adminFields.js`、`/admin/fields`，權限沿用 `categories.manage`）：定義在 `asset_field_defs`（type：text/number/date/select/boolean，`options`／`category_codes` 是 JSON 陣列文字，`category_codes` 為 NULL＝所有類別），值在 `asset_field_values`（只存有填的，值一律是文字，清空就刪列）。規則比照設備類型：**有任何值的欄位只能停用、不能刪除、不能改類型**。`Asset.findAll/findById/findByIds/search` 會呼叫 `AssetField.attach` 補上 `custom`／`customDisplay`／`customSearch`；**自己用 SQL 取設備的地方（例如 `InspectionBatch.getAssets`）要自己呼叫 `AssetField.attach`**（報告路由已做）。表單欄位名稱 `cf_<欄位id>`，`AssetField.parse` 只處理「啟用、適用該類別、而且有送出」的欄位（被隱藏而停用的欄位不送出＝保持原值），寫入與資產同一個交易（`Asset.create/update` 的 `custom` 參數）。顯示（列表／報告）只含啟用且適用的欄位；停用欄位的資料保留、不顯示、不搜尋。新增欄位類型時要同步 `parse`、`formatValue`、`views/assets/form.ejs`
- **設備挑選器**（`views/partials/asset-picker.ejs` + `public/js/asset-picker.js`，建立批次與填寫頁共用）：篩選只改「顯示」（`hidden`），被隱藏的勾選框仍在表單裡、會一起送出；改它時要保留這個性質。表單欄位名稱固定 `asset_ids`（後端靠它）。設備上千台才需要改成伺服器端搜尋
- **簽核流程**（`services/ApprovalService.js`、migration 0010、`/admin/approval`）：`inspection_batches.approval_status`（none/pending/approved/returned）與原本的 `status`（draft/completed）並存——最後一關核准才把 `status` 設成 completed，所以舊的頁面與 PDF 判斷不用改；`none` 代表沒走簽核（含舊資料，行為完全不變）。鎖定判斷一律走 `ApprovalService.isLocked(batch)` 並在**伺服器端**擋（`routes/batches.js` 的 `rejectIfLocked`），新增會修改批次內容的路由時記得加。`approval_records` 在送審時快照關卡名稱/順序/群組，`stage_id`/`group_id` 刻意沒加外鍵（日後刪關卡/群組不會被歷史卡住）。簽核人資格靠 `req.user.group_id`（`app.js` 每個請求即時帶入，不在 session 裡）——**不要把 group_id 拿掉**，否則群組成員會永遠被判定不是簽核人。通知用 `models/Notification.js`，只存站內通知（Email 之後加）
- **Email 通知**（`services/MailService.js`、migration 0011、`/admin/mail`）：站內通知先寫進資料庫、**交易提交後**才在背景寄信（`queueNotificationEmail` 用 `setImmediate`），結果寫回 `notifications.email_status/email_error`；寄信失敗絕不可讓觸發它的動作失敗。SMTP 密碼 / M365 Client Secret 經 `utils/secretBox.js`（AES-256-GCM，金鑰由 `SESSION_SECRET` 衍生）加密存 `mail_settings`，**絕不可把解密後的值放進 view、log 或錯誤訊息**。新增會通知人的事件：寫 `Notification.create(...)` 之後呼叫 `MailService.queueNotificationEmail(id)`。信件內容一律經 `esc()` 做 HTML 跳脫（標題含使用者輸入的批次名稱）。`requireLogin` 會記住 GET 的原網址（`safeReturnPath` 只接受站內路徑，防開放式轉址），登入後回到那裡
- **權限群組**（`PermissionGroup`、`utils/permissions.js`、`/admin/groups`）：`users.role` 仍只有 admin / technician（admin 擁有全部權限，不可靠群組取得或失去）；群組只替技術人員額外授權，權限 key 清單寫在 `utils/permissions.js`（新增權限就加一筆，不用改資料表；key 寫進資料庫後不要改名）。`req.user.permissions` 由 `app.js` 每個請求依資料庫重算（不存 session，調整立即生效）；路由用 `requirePermission('key')`、view 用 `can('key')`——**不要再新增 `role === 'admin'` 判斷來限制某個「可授權」的功能**。刻意沒有重建 `users` 表（被大量引用）
- **設備類型與檢查項目不再寫死**：存在 `asset_categories` / `checklist_items`（migration 0008，管理頁 `/admin/categories`）。類型的 `code` 建立後不可改（資產與項目都用 code 關聯，內建四個沿用 pc/server/nas/network_device），只有顯示名稱能改；`validators.js` 裡不要再放類型清單。規則：用過的類型/項目只能停用（`is_active`）不能刪除；已有紀錄的資產不能改類型；項目名稱在記錄時快照到 `inspection_items.item_label`，報告/摘要一律讀 `COALESCE(item_label, label)`（`InspectionItem.findByBatch`），不要直接 join `checklist_items.label` 顯示在已完成的報告上；類型名稱不做快照
- **改資料表結構（重建表）的 migration** 要設 `module.exports.disableForeignKeys = true`（`runner.js` 會在交易外關閉外鍵，因為交易內的 `PRAGMA foreign_keys` 無效），並在 COMMIT 前自己跑 `PRAGMA foreign_key_check` 驗證；`runner.js` 升級既有資料庫前會自動快照到 `data/pre-migrate-snapshots/`（保留 5 份）。舊的 migration 檔（含 0001 的 CHECK 與種子）不要改，只在尾端新增
- 網頁「備份管理」（`src/services/BackupService.js`）由服務帳號在**服務行程內**產生備份（SQLite `db.backup()` 快照 + `tar`），預設啟用每天 02:00（台北時間）；備份目錄由 systemd unit 的 `Environment=BACKUP_DIR=`（deploy.sh 寫入）決定，沒設定就用專案內的 `backups/`。檔案格式必須維持與 `backup.sh`/`restore.sh` 相容（`backup_YYYYMMDD_HHMMSS.tar.gz`，內含同名資料夾、`data/maint_report.db`、`uploads/`）。**還原刻意不做在網頁上**。下載/刪除的檔名一律用 `FILENAME_RE` 驗證，不要放寬
- 截圖檢視（`public/js/photo-viewer.js`）是就地展開的檢視區（比照 expense-platform，刻意不用 `window.open`／新分頁，因為快顯封鎖會讓功能失效）：連結寫 `data-viewer="檢視區id"`、檢視區元素加 `data-viewer-host`，檢視區在 `<tr>` 裡時整列一起顯示/隱藏。CSS 只能用 tokens.css 有定義的間距變數（`--space-2/4/6/8/12`，沒有 `--space-3`，用了不會報錯但會靜默失效）
- 自訂分頁圖示（`BrandingService`、`routes/branding.js`、`/admin/branding`）：圖示以 PNG BLOB 存在資料庫 `branding` 表（所以備份會帶走），圖示網址是公開的且掛在 session 之前（瀏覽器抓 favicon 不一定帶登入資訊）。**上傳只接受點陣圖，不可放寬成 SVG**（伺服器端解碼不明 SVG 有安全風險）；所有頁面 `<head>` 都要 `include('partials/head-icons')`，新增獨立頁面時別漏掉
- 「系統狀態」（`HealthService`）與線上使用者（`ActivityTracker`，只存記憶體）僅限管理員；`GET /healthz` 是唯一公開的健康端點，只能回極簡資訊，不要加任何系統細節
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
