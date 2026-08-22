#!/bin/bash
# 維護巡檢報告系統 - 一鍵部署腳本
# 功能：首次安裝 + 更新部署（自動偵測）

set -e

# 顏色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 專案目錄
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 檢查是否為 root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[錯誤]${NC} 需要 root 權限，請使用 sudo 執行：sudo ./deploy.sh"
    exit 1
fi

# 日誌函數
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[錯誤]${NC} $1"
    exit 1
}

warning() {
    echo -e "${YELLOW}[警告]${NC} $1"
}

info() {
    echo -e "${BLUE}[資訊]${NC} $1"
}

# 確認函數
confirm() {
    read -p "$(echo -e ${YELLOW}$1${NC}) [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1
    fi
    return 0
}

# 交互式輸入配置
input_config() {
    echo ""
    info "請輸入部署配置資訊（直接按 Enter 使用預設值）："
    echo ""

    # 服務端口
    while true; do
        read -p "$(echo -e ${YELLOW}服務端口 [3000]:${NC}) " input_port
        PORT="${input_port:-3000}"
        if [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; then
            break
        else
            echo -e "${RED}無效的端口號，請輸入 1-65535 之間的數字${NC}"
        fi
    done

    # 服務名稱
    read -p "$(echo -e ${YELLOW}服務名稱 [maint-report-system]:${NC}) " input_service
    SERVICE_NAME="${input_service:-maint-report-system}"

    # 安裝目錄名稱（/srv/apps 下的資料夾名稱）
    read -p "$(echo -e ${YELLOW}安裝目錄名稱（/srv/apps 下的資料夾名稱）[maint-report-system]:${NC}) " input_install_dir
    INSTALL_DIR_NAME="${input_install_dir:-maint-report-system}"
    INSTALL_DIR="/srv/apps/${INSTALL_DIR_NAME}"

    # 備份目錄名稱
    read -p "$(echo -e ${YELLOW}備份目錄名稱（/srv/apps 下的資料夾名稱）[maint-report-system-backups]:${NC}) " input_backup_dir
    BACKUP_DIR_NAME="${input_backup_dir:-maint-report-system-backups}"
    BACKUP_DIR="/srv/apps/${BACKUP_DIR_NAME}"

    echo ""
    info "配置摘要："
    echo "  服務端口: $PORT"
    echo "  服務名稱: $SERVICE_NAME"
    echo "  安裝目錄: $INSTALL_DIR"
    echo "  備份目錄: $BACKUP_DIR"
    echo ""

    if ! confirm "確認使用以上配置？"; then
        log "部署已取消"
        exit 0
    fi
}

# 輸入配置，或從既有設定檔讀取
if [ -f "${PROJECT_DIR}/deploy.config.sh" ]; then
    source "${PROJECT_DIR}/deploy.config.sh"
    info "已從 deploy.config.sh 讀取現有配置（服務：${SERVICE_NAME}，目錄：${INSTALL_DIR}）"
else
    input_config
fi

# 開始部署
echo "============================================"
echo "  維護巡檢報告系統"
echo "  一鍵部署程式"
echo "============================================"
echo ""

# 偵測是首次安裝還是更新
IS_FIRST_INSTALL=false
if ! systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
    IS_FIRST_INSTALL=true
    info "偵測到首次安裝，將執行完整安裝流程..."
else
    info "偵測到已安裝系統，將執行更新部署..."
fi

echo ""
log "開始部署流程..."

# ========================================
# 首次安裝特有步驟
# ========================================
if [ "$IS_FIRST_INSTALL" = true ]; then
    log "=== 首次安裝流程 ==="

    # 檢查並安裝 Node.js
    log "檢查 Node.js..."
    if ! command -v node &> /dev/null; then
        log "Node.js 未安裝，開始安裝 Node.js 20.x..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || error "Node.js 安裝失敗"
        sudo apt-get install -y nodejs || error "Node.js 安裝失敗"
        log "✓ Node.js 安裝完成"
    else
        NODE_VERSION=$(node -v)
        log "✓ Node.js 已安裝: $NODE_VERSION"
    fi

    NPM_VERSION=$(npm -v)
    log "✓ npm 版本: $NPM_VERSION"

    # 如果腳本不在安裝目錄，複製過去
    if [ "$PROJECT_DIR" != "$INSTALL_DIR" ]; then
        log "複製專案文件到 ${INSTALL_DIR}..."
        mkdir -p "$INSTALL_DIR" || error "無法創建安裝目錄"

        if command -v rsync &> /dev/null; then
            rsync -av --exclude='node_modules' --exclude='.git' --exclude='*.log' \
                --exclude='data/*.db' --exclude='uploads/*' \
                "${PROJECT_DIR}/" "${INSTALL_DIR}/" || error "複製專案文件失敗"
        else
            cp -r "${PROJECT_DIR}/." "${INSTALL_DIR}/" || error "複製專案文件失敗"
            rm -rf "${INSTALL_DIR}/node_modules" 2>/dev/null || true
            rm -rf "${INSTALL_DIR}/.git" 2>/dev/null || true
        fi

        log "✓ 專案文件已複製"
        PROJECT_DIR="$INSTALL_DIR"
        cd "$PROJECT_DIR"
    fi

    # 創建必要目錄
    log "創建必要目錄..."
    mkdir -p "${PROJECT_DIR}/data"
    mkdir -p "${PROJECT_DIR}/uploads"
    mkdir -p "${BACKUP_DIR}"
    chmod 755 "${BACKUP_DIR}" 2>/dev/null || true
    log "✓ 目錄創建完成"

    # 設定腳本權限
    log "設定腳本權限..."
    chmod +x "${PROJECT_DIR}/deploy.sh" 2>/dev/null || true
    chmod +x "${PROJECT_DIR}/backup.sh" 2>/dev/null || true
    chmod +x "${PROJECT_DIR}/restore.sh" 2>/dev/null || true
    chmod +x "${PROJECT_DIR}/uninstall.sh" 2>/dev/null || true
    chmod +x "${PROJECT_DIR}/setup-backup-timer.sh" 2>/dev/null || true
    chmod +x "${PROJECT_DIR}/scripts/health-check.sh" 2>/dev/null || true
    log "✓ 腳本權限設定完成"
fi

# ========================================
# 共同步驟（首次安裝 + 更新都執行）
# ========================================

# 步驟 1: 停止服務（僅更新時需要）
if [ "$IS_FIRST_INSTALL" = false ]; then
    log "步驟 1/6: 停止服務..."
    if sudo systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log "正在停止服務..."
        sudo systemctl stop "${SERVICE_NAME}" || warning "服務停止失敗，繼續執行..."
        sleep 2

        PORT_PID=$(sudo lsof -ti:${PORT} 2>/dev/null || echo "")
        if [ -n "$PORT_PID" ]; then
            PORT_PROC_CMD=$(ps -p "$PORT_PID" -o args= 2>/dev/null || echo "")
            if echo "$PORT_PROC_CMD" | grep -q "app\.js"; then
                warning "檢測到端口 ${PORT} 仍被本專案的程序佔用 (PID: $PORT_PID)，正在終止..."
                sudo kill -9 "$PORT_PID" 2>/dev/null || warning "無法終止進程，可能需要手動處理"
                sleep 1
            else
                error "端口 ${PORT} 被非本專案的程序佔用 (PID: $PORT_PID，指令: ${PORT_PROC_CMD:-未知})。為避免誤殺無關程序，部署已停止，請手動確認並釋放該端口後重新執行。"
            fi
        fi

        if sudo systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
            error "服務無法停止，請手動檢查：sudo systemctl status ${SERVICE_NAME}"
        else
            log "✓ 服務已成功停止"
        fi
    else
        log "服務未運行"
    fi
else
    log "步驟 1/6: 跳過（首次安裝無需停止服務）"
    PORT_PID=$(sudo lsof -ti:${PORT} 2>/dev/null || echo "")
    if [ -n "$PORT_PID" ]; then
        PORT_PROC_CMD=$(ps -p "$PORT_PID" -o args= 2>/dev/null || echo "")
        if echo "$PORT_PROC_CMD" | grep -q "app\.js"; then
            warning "檢測到端口 ${PORT} 被本專案的舊程序佔用 (PID: $PORT_PID)，正在清理..."
            sudo kill -9 "$PORT_PID" 2>/dev/null || true
            sleep 1
        else
            error "端口 ${PORT} 被非本專案的程序佔用 (PID: $PORT_PID，指令: ${PORT_PROC_CMD:-未知})。為避免誤殺無關程序，部署已停止，請手動確認並釋放該端口後重新執行。"
        fi
    fi
fi

# 步驟 2: 安裝／更新依賴套件
log "步驟 2/6: 檢查並更新依賴套件..."
cd "${PROJECT_DIR}"
if [ "${PROJECT_DIR}/package.json" -nt "${PROJECT_DIR}/node_modules/.package-lock.json" ] 2>/dev/null || \
   [ ! -d "${PROJECT_DIR}/node_modules" ]; then
    log "檢測到 package.json 更新，重新安裝依賴..."
    npm install || error "依賴套件安裝失敗"
    if [ -z "${SKIP_AUDIT_FIX:-}" ]; then
        log "修復已知安全性漏洞（僅套用不需要 --force 的修復，不含破壞性變更）..."
        npm audit fix 2>&1 | tail -10 || true
        info "若上方仍列出需要 --force 才能修的項目，代表該修復含破壞性變更，不會自動套用，需手動評估後執行 npm audit fix --force"
    else
        info "SKIP_AUDIT_FIX=1，略過自動修復已知安全性漏洞"
    fi
    log "✓ 依賴套件更新完成"
else
    log "✓ 依賴套件無需更新"
fi

# 步驟 3: 執行資料庫 migration（失敗即停止，不啟動服務）
log "步驟 3/6: 執行資料庫 migration..."
if ! node migrations/runner.js; then
    error "Migration 執行失敗，部署已停止（不會啟動服務，避免帶著不完整的 schema 上線）。
  請檢查上方 migration 錯誤輸出並修正；已成功的 migration 已被記錄於 schema_migrations，
  修正後重新執行本腳本時只會重跑尚未成功的項目。"
fi
log "✓ 資料庫 migration 完成"

# 步驟 4: 檢查並更新 systemd 服務配置
log "步驟 4/6: 檢查 systemd 服務配置..."
CURRENT_USER=${SUDO_USER:-$USER}
if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
    error "本服務不應以 root 身份執行，請使用 sudo 但以一般使用者帳號登入後執行（\$SUDO_USER 需為非 root 使用者）"
fi

# 本腳本整體以 root 執行（含前面的 migration 步驟），data/uploads 目錄與
# SQLite 檔案因此會是 root 擁有；但 systemd service 是以 ${CURRENT_USER}
# 身份執行，若不修正擁有者，服務啟動時會因為無法在 data/ 目錄寫入
# WAL/SHM 檔案而以 SQLITE_READONLY_DIRECTORY 崩潰。每次部署都修正一次，
# 確保重複執行／更新後擁有者不會因為某次以 root 手動操作而跑掉。
chown -R "${CURRENT_USER}:${CURRENT_USER}" "${PROJECT_DIR}/data" "${PROJECT_DIR}/uploads" "${BACKUP_DIR}" \
    || warning "調整 data/uploads/${BACKUP_DIR} 擁有者失敗，服務可能無法寫入資料庫或截圖"

NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    error "找不到 Node.js 執行檔"
fi

# M365 SSO 是選用功能，設定值（含 Client Secret）不能寫進 systemd unit 本身
# ——unit 檔案在 /etc/systemd/system/ 底下預設是所有人可讀（644），任何一個
# 能登入這台主機的帳號都看得到。改成一個權限鎖死（600，只有服務執行帳號能讀）
# 的獨立檔案，unit 只用 EnvironmentFile 引用路徑。這裡只在檔案不存在時建立
# 一份空白範本，不會覆蓋既有設定；使用者只需要編輯這個檔案的內容，不用再碰
# systemd unit。
M365_ENV_DIR="/etc/maint-report-system"
M365_ENV_FILE="${M365_ENV_DIR}/m365.env"
if [ ! -f "$M365_ENV_FILE" ]; then
    mkdir -p "$M365_ENV_DIR"
    cat > "$M365_ENV_FILE" <<'EOF'
# Microsoft 365 SSO 設定（選用）——四個都填了才會在登入頁顯示「使用 Microsoft
# 365 登入」按鈕，不填的話系統照常只用帳號密碼登入，不會出錯。
# 申請/填寫步驟見 README.md「Microsoft 365 SSO」一節。
# M365_CLIENT_ID=
# M365_CLIENT_SECRET=
# M365_TENANT_ID=
# M365_REDIRECT_URI=http://your-domain-or-ip:3000/auth/m365/callback
EOF
    chown "${CURRENT_USER}:${CURRENT_USER}" "$M365_ENV_FILE"
    chmod 600 "$M365_ENV_FILE"
    log "✓ 已建立 ${M365_ENV_FILE}（空白範本，權限已鎖為僅服務帳號可讀）"
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

NEED_UPDATE=false
if [ ! -f "$SERVICE_FILE" ]; then
    NEED_UPDATE=true
    log "服務文件不存在，將創建新文件"
else
    if ! grep -q "WorkingDirectory=${PROJECT_DIR}" "$SERVICE_FILE" 2>/dev/null; then
        NEED_UPDATE=true
        log "檢測到專案目錄變更，需要更新服務文件"
    fi
    # 舊版部署的 unit 檔案可能是在支援 M365 EnvironmentFile 之前產生的，
    # 補上這行才能讀到 m365.env，不用因為這樣就要求使用者整個重新安裝。
    if ! grep -q "^EnvironmentFile=-${M365_ENV_FILE}$" "$SERVICE_FILE" 2>/dev/null; then
        NEED_UPDATE=true
        log "偵測到服務文件缺少 M365 EnvironmentFile 設定，需要更新服務文件"
    fi
fi

if [ "$NEED_UPDATE" = true ]; then
    log "更新 systemd 服務文件..."
    # 保留現有 SESSION_SECRET；首次安裝時產生隨機值
    EXISTING_SECRET=$(grep "^Environment=SESSION_SECRET=" "$SERVICE_FILE" 2>/dev/null | cut -d'=' -f3-)
    if [ -z "$EXISTING_SECRET" ]; then
        EXISTING_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)
        log "已產生新的 SESSION_SECRET"
    fi
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=維護巡檢報告系統
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CURRENT_USER}
Group=${CURRENT_USER}
WorkingDirectory=${PROJECT_DIR}
Environment=NODE_ENV=production
Environment=PORT=${PORT}
Environment="PATH=${PATH}"
Environment=SESSION_SECRET=${EXISTING_SECRET}
EnvironmentFile=-${M365_ENV_FILE}
ExecStart=${NODE_PATH} ${PROJECT_DIR}/src/app.js
Restart=always
RestartSec=10
StartLimitInterval=0
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF
    log "服務文件已更新"

    log "重新載入 systemd daemon..."
    sudo systemctl daemon-reload

    if ! sudo systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log "啟用服務（開機自動啟動）..."
        sudo systemctl enable "${SERVICE_NAME}" || warning "無法啟用服務"
    fi
else
    log "服務配置無需更新"
fi

# 步驟 5: 保存部署配置（供 backup.sh / restore.sh / uninstall.sh 使用）
log "步驟 5/6: 保存部署配置..."
DEPLOY_CONFIG_FILE="${PROJECT_DIR}/deploy.config.sh"
cat > "$DEPLOY_CONFIG_FILE" <<EOF
#!/bin/bash
# 部署配置文件（由 deploy.sh 自動生成，供腳本使用）
PORT=${PORT}
SERVICE_NAME="${SERVICE_NAME}"
INSTALL_DIR_NAME="${INSTALL_DIR_NAME}"
BACKUP_DIR_NAME="${BACKUP_DIR_NAME}"
INSTALL_DIR="${INSTALL_DIR}"
BACKUP_DIR="${BACKUP_DIR}"
EOF
chmod 755 "$DEPLOY_CONFIG_FILE" 2>/dev/null || true

chmod +x "${PROJECT_DIR}/backup.sh" 2>/dev/null || true
chmod +x "${PROJECT_DIR}/setup-backup-timer.sh" 2>/dev/null || true
log "✓ 配置已保存到 ${DEPLOY_CONFIG_FILE}"

# 步驟 6: 啟動服務
log "步驟 6/6: 啟動服務..."
if sudo systemctl start "${SERVICE_NAME}" 2>/dev/null; then
    log "服務啟動命令已執行"
    sleep 3

    if sudo systemctl is-active --quiet "${SERVICE_NAME}"; then
        log "✓ 服務已成功啟動並運行中"
        info "服務狀態："
        sudo systemctl status "${SERVICE_NAME}" --no-pager -l | head -n 15 | sed 's/^/  /'
        SERVICE_STATUS="✓ 已啟動並運行"
    else
        warning "服務可能未正常啟動，正在檢查原因..."
        JOURNAL_LOG=$(sudo journalctl -u "${SERVICE_NAME}" -n 20 --no-pager 2>/dev/null || echo "")
        if [ -n "$JOURNAL_LOG" ]; then
            warning "最近的服務日誌："
            echo "$JOURNAL_LOG" | sed 's/^/  /'
        fi
        SERVICE_STATUS="✗ 啟動異常"
        warning "請執行以下命令檢查詳細狀態："
        warning "  sudo systemctl status ${SERVICE_NAME}"
        warning "  sudo journalctl -u ${SERVICE_NAME} -f"
    fi
else
    error "服務啟動失敗，請檢查日誌：sudo journalctl -u ${SERVICE_NAME}"
fi

echo ""
echo "============================================"
echo -e "${GREEN}  部署完成！${NC}"
echo "============================================"
echo ""

log "部署流程完成"

if [ "$IS_FIRST_INSTALL" = true ]; then
    echo "安裝資訊："
    echo "  - 安裝目錄: $PROJECT_DIR"
    echo "  - 資料庫位置: ${PROJECT_DIR}/data/maint_report.db"
    echo "  - 備份目錄: ${BACKUP_DIR}"
    echo "  - 服務狀態: ${SERVICE_STATUS:-未知}"
    echo "  - 開機自動啟動: 已啟用"
    echo ""
    echo "預設登入資訊："
    echo "  - 帳號: admin"
    echo "  - 密碼: admin123"
    echo "  - 首次登入後請立即修改密碼！"
else
    echo "系統資訊："
    echo "  - 專案目錄: $PROJECT_DIR"
    echo "  - 服務狀態: ${SERVICE_STATUS:-未知}"
    echo "  - 開機自動啟動: $(sudo systemctl is-enabled ${SERVICE_NAME} 2>/dev/null && echo '已啟用' || echo '未啟用')"
fi

echo ""
echo "服務管理："
echo "  啟動服務: sudo systemctl start ${SERVICE_NAME}"
echo "  停止服務: sudo systemctl stop ${SERVICE_NAME}"
echo "  重啟服務: sudo systemctl restart ${SERVICE_NAME}"
echo "  查看狀態: sudo systemctl status ${SERVICE_NAME}"
echo "  查看日誌: sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "系統網址: http://localhost:${PORT}"
echo ""

# 檢查是否已設定自動備份
BACKUP_SERVICE_NAME="${SERVICE_NAME}-backup"
BACKUP_TIMER_EXISTS=0
if systemctl list-unit-files | grep -q "^${BACKUP_SERVICE_NAME}.timer"; then
    BACKUP_TIMER_EXISTS=1
fi

if [ $BACKUP_TIMER_EXISTS -eq 1 ]; then
    info "自動備份已設定"
    if [ -z "$SKIP_BACKUP_PROMPT" ]; then
        read -p "是否要修改自動備份設定？(y/N): " MODIFY_BACKUP
        if [[ "$MODIFY_BACKUP" =~ ^[Yy]$ ]]; then
            if [ -f "${PROJECT_DIR}/setup-backup-timer.sh" ]; then
                chmod +x "${PROJECT_DIR}/setup-backup-timer.sh"
                bash "${PROJECT_DIR}/setup-backup-timer.sh"
            fi
        fi
    else
        info "如需修改備份設定，請手動執行: sudo ${PROJECT_DIR}/setup-backup-timer.sh"
    fi
else
    echo ""
    info "系統尚未設定自動備份"
    if [ -z "$SKIP_BACKUP_PROMPT" ]; then
        read -p "是否要設定自動備份？(Y/n): " SETUP_BACKUP
        if [[ ! "$SETUP_BACKUP" =~ ^[Nn]$ ]]; then
            if [ -f "${PROJECT_DIR}/setup-backup-timer.sh" ]; then
                chmod +x "${PROJECT_DIR}/setup-backup-timer.sh"
                log "設定自動備份（預設：每日凌晨 2:00）..."
                bash "${PROJECT_DIR}/setup-backup-timer.sh" "1"
                if systemctl list-unit-files | grep -q "^${BACKUP_SERVICE_NAME}.timer"; then
                    systemctl daemon-reload
                    systemctl restart "${BACKUP_SERVICE_NAME}.timer"
                    log "✓ 自動備份已設定完成"
                fi
            fi
        else
            info "跳過自動備份設定"
            echo "您可以稍後執行以下命令設定自動備份："
            echo "  sudo ${PROJECT_DIR}/setup-backup-timer.sh"
        fi
    else
        info "如需設定自動備份，請手動執行: sudo ${PROJECT_DIR}/setup-backup-timer.sh"
    fi
fi

echo ""
echo "============================================"
echo ""
echo "備份管理："
echo "  手動備份:     sudo ${PROJECT_DIR}/backup.sh"
echo "  設定自動備份:  sudo ${PROJECT_DIR}/setup-backup-timer.sh"
if [ $BACKUP_TIMER_EXISTS -eq 1 ]; then
    echo "  查看備份計畫:  sudo systemctl list-timers ${BACKUP_SERVICE_NAME}.timer"
    echo "  立即執行備份:  sudo systemctl start ${BACKUP_SERVICE_NAME}.service"
fi
echo ""
