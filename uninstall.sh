#!/bin/bash
# 維護巡檢報告系統 - 移除腳本（含備份）

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()     { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[錯誤]${NC} $1"; exit 1; }
warning() { echo -e "${YELLOW}[警告]${NC} $1"; }
info()    { echo -e "${BLUE}[資訊]${NC} $1"; }

confirm() {
    read -p "$(echo -e ${YELLOW}$1${NC}) [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1
    fi
    return 0
}

DEPLOY_CONFIG_FILE="${PROJECT_DIR}/deploy.config.sh"
if [ -f "$DEPLOY_CONFIG_FILE" ]; then
    source "$DEPLOY_CONFIG_FILE"
else
    INSTALL_DIR_NAME="maint-report-system"
    BACKUP_DIR_NAME="maint-report-system-backups"
    INSTALL_DIR="/srv/apps/${INSTALL_DIR_NAME}"
    BACKUP_DIR="/srv/apps/${BACKUP_DIR_NAME}"
    SERVICE_NAME="maint-report-system"
fi

TIMESTAMP=$(date +'%Y%m%d_%H%M%S')
UNINSTALL_BACKUP="${BACKUP_DIR}/uninstall_backup_${TIMESTAMP}.tar.gz"
TEMP_BACKUP_DIR="${PROJECT_DIR}/temp_uninstall_backup"

echo "============================================"
echo "  維護巡檢報告系統"
echo "  移除程式（含備份）"
echo "============================================"
echo ""

if [ "$EUID" -ne 0 ]; then
    error "移除操作需要 root 權限，請使用 sudo 執行此腳本：sudo ./uninstall.sh"
fi

warning "此操作將移除整個系統，包括："
echo "  - 所有專案檔案"
echo "  - 資料庫"
echo "  - 上傳檔案（截圖）"
echo "  - node_modules"
echo ""
info "但在移除前會自動建立完整備份"
echo ""

if ! confirm "確定要移除系統嗎？"; then
    log "移除操作已取消"
    exit 0
fi

# 步驟 1: 自動備份
log "步驟 1/4: 自動備份系統資料..."
mkdir -p "$BACKUP_DIR"
chmod 755 "$BACKUP_DIR" || true

rm -rf "$TEMP_BACKUP_DIR"
mkdir -p "$TEMP_BACKUP_DIR"

if [ -f "${PROJECT_DIR}/data/maint_report.db" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        log "執行 WAL checkpoint..."
        sqlite3 "${PROJECT_DIR}/data/maint_report.db" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || warning "WAL checkpoint 失敗，但繼續備份"
        sleep 1
    fi
    mkdir -p "${TEMP_BACKUP_DIR}/data"
    cp "${PROJECT_DIR}/data/maint_report.db" "${TEMP_BACKUP_DIR}/data/maint_report.db" || error "資料庫備份失敗"
    DB_SIZE=$(du -h "${PROJECT_DIR}/data/maint_report.db" | cut -f1)
    log "資料庫已備份，大小: $DB_SIZE"
fi

if [ -d "${PROJECT_DIR}/uploads" ] && [ "$(ls -A "${PROJECT_DIR}/uploads" 2>/dev/null)" ]; then
    cp -r "${PROJECT_DIR}/uploads" "${TEMP_BACKUP_DIR}/" 2>/dev/null || true
    UPLOADS_COUNT=$(find "${PROJECT_DIR}/uploads" -type f 2>/dev/null | wc -l)
    log "上傳檔案已備份，檔案數: $UPLOADS_COUNT"
fi

[ -f "${PROJECT_DIR}/package.json" ] && cp "${PROJECT_DIR}/package.json" "${TEMP_BACKUP_DIR}/package.json"

cat > "${TEMP_BACKUP_DIR}/uninstall_info.txt" << EOF
移除時間: $(date +'%Y-%m-%d %H:%M:%S')
備份名稱: uninstall_backup_${TIMESTAMP}
專案目錄: $PROJECT_DIR
備份內容:
  - 資料庫: data/maint_report.db
  - 上傳檔案: uploads/
還原說明:
  1. 解壓此備份檔案
  2. 執行: sudo ./restore.sh uninstall_backup_${TIMESTAMP}.tar.gz
EOF

cd "$PROJECT_DIR"
tar -czf "$UNINSTALL_BACKUP" -C "$PROJECT_DIR" "temp_uninstall_backup" || error "備份壓縮失敗"
rm -rf "$TEMP_BACKUP_DIR"
BACKUP_SIZE=$(du -h "$UNINSTALL_BACKUP" | cut -f1)
log "備份完成，備份檔案: $(basename "$UNINSTALL_BACKUP")，大小: $BACKUP_SIZE"

echo ""
warning "備份已完成，即將開始移除系統檔案"
if ! confirm "確定要繼續移除嗎？"; then
    log "移除操作已取消，備份檔案已保留: $UNINSTALL_BACKUP"
    exit 0
fi

# 步驟 2: 停止並移除 systemd 服務
log "步驟 2/4: 停止並移除 systemd 服務..."
if [ -n "$SERVICE_NAME" ] && systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
    if sudo systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
        sleep 2
    fi
    sudo systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
    sudo rm -f "/etc/systemd/system/${SERVICE_NAME}.service" 2>/dev/null || true

    if systemctl list-unit-files | grep -q "^${SERVICE_NAME}-backup.timer"; then
        sudo systemctl stop "${SERVICE_NAME}-backup.timer" 2>/dev/null || true
        sudo systemctl disable "${SERVICE_NAME}-backup.timer" 2>/dev/null || true
        sudo rm -f "/etc/systemd/system/${SERVICE_NAME}-backup.timer" 2>/dev/null || true
        sudo rm -f "/etc/systemd/system/${SERVICE_NAME}-backup.service" 2>/dev/null || true
    fi
    sudo systemctl daemon-reload 2>/dev/null || true
    log "systemd 服務已移除"
else
    log "systemd 服務 ${SERVICE_NAME} 不存在，跳過"
fi

# 檢查並終止相關 Node.js 進程
APP_PIDS=$(ps aux | grep "[n]ode.*app.js" | grep -v grep | awk '{print $2}' || echo "")
if [ -n "$APP_PIDS" ]; then
    for pid in $APP_PIDS; do
        sudo kill -9 "$pid" 2>/dev/null || true
    done
    sleep 1
fi

# 步驟 3: 移除檔案
log "步驟 3/4: 移除系統檔案和目錄..."
rm -rf "${PROJECT_DIR}/node_modules" 2>/dev/null || true
rm -f "${PROJECT_DIR}/data/maint_report.db"* 2>/dev/null || true
rmdir "${PROJECT_DIR}/data" 2>/dev/null || true
if [ -d "${PROJECT_DIR}/uploads" ]; then
    rm -rf "${PROJECT_DIR}/uploads"/*
    rmdir "${PROJECT_DIR}/uploads" 2>/dev/null || true
fi
rm -f "${PROJECT_DIR}"/*.log 2>/dev/null || true
rm -rf "${PROJECT_DIR}/temp_restore_"* 2>/dev/null || true
rm -rf "${PROJECT_DIR}/coverage" 2>/dev/null || true

# 步驟 4: 移除整個安裝目錄（如果是在 /srv/apps 下）
log "步驟 4/4: 移除安裝目錄..."
if [ "$(dirname "$PROJECT_DIR")" = "/srv/apps" ]; then
    log "移除安裝目錄: $PROJECT_DIR"
    rm -rf "$PROJECT_DIR" || warning "無法完全移除安裝目錄，可能需要手動清理"
    log "安裝目錄已移除"
else
    log "不在標準安裝目錄中（非 /srv/apps 路徑），跳過移除安裝目錄步驟"
    info "如需移除開發目錄，請手動執行: rm -rf $PROJECT_DIR"
fi

echo ""
echo "============================================"
echo -e "${GREEN}  系統移除完成！${NC}"
echo "============================================"
echo ""
info "備份檔案已保留: $(basename "$UNINSTALL_BACKUP")"
info "備份位置: $BACKUP_DIR"
echo ""
echo "還原備份："
echo "  ./restore.sh uninstall_backup_${TIMESTAMP}.tar.gz"
echo ""
