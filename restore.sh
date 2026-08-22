#!/bin/bash
# 維護巡檢報告系統 - 還原腳本

# 注意：不使用 set -e，需要自行捕獲錯誤並處理
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[錯誤]${NC} $1"; exit 1; }
warning() { echo -e "${YELLOW}[警告]${NC} $1"; }
info()    { echo -e "${BLUE}[資訊]${NC} $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

list_install_dirs() {
    local dirs=()
    local index=1

    echo "可用的安裝目錄：" >&2
    while IFS= read -r dir; do
        if [ -d "$dir" ] && [ -f "${dir}/package.json" ]; then
            dirs+=("$dir")
            local size=$(du -sh "$dir" 2>/dev/null | cut -f1 || echo "未知")
            printf "  [%2d] %s (大小: %s)\n" "$index" "$dir" "$size" >&2
            ((index++))
        fi
    done < <(find /srv/apps -maxdepth 1 -type d 2>/dev/null | sort)

    if [ -f "${SCRIPT_DIR}/package.json" ] && [[ "$SCRIPT_DIR" != /srv/apps/* ]]; then
        dirs+=("$SCRIPT_DIR")
        local size=$(du -sh "$SCRIPT_DIR" 2>/dev/null | cut -f1 || echo "未知")
        printf "  [%2d] %s (當前目錄, 大小: %s)\n" "$index" "$SCRIPT_DIR" "$size" >&2
        ((index++))
    fi

    if [ ${#dirs[@]} -eq 0 ]; then
        echo "  未找到安裝目錄" >&2
        return 1
    fi

    while true; do
        read -p "$(echo -e ${YELLOW}請選擇要還原到的安裝目錄編號 [1-${#dirs[@]}]，或按 q 取消:${NC}) " selection
        if [[ "$selection" =~ ^[Qq]$ ]]; then
            log "還原操作已取消" >&2
            exit 0
        fi
        if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#dirs[@]}" ]; then
            echo "${dirs[$((selection-1))]}"
            return 0
        else
            echo -e "${RED}無效的選擇${NC}" >&2
        fi
    done
}

list_services() {
    local services=()
    local index=1

    echo "" >&2
    echo "可用的 systemd 服務：" >&2
    while IFS= read -r service_file; do
        if [ -f "$service_file" ]; then
            local service_name=$(basename "$service_file" .service)
            if [[ "$service_name" == *backup* ]]; then continue; fi
            if grep -q "app.js" "$service_file" 2>/dev/null; then
                services+=("$service_name")
                local status=$(systemctl is-active "$service_name" 2>/dev/null || echo "unknown")
                printf "  [%2d] %s (狀態: %s)\n" "$index" "$service_name" "$status" >&2
                ((index++))
            fi
        fi
    done < <(find /etc/systemd/system -maxdepth 1 -name "*.service" 2>/dev/null | sort)

    if [ ${#services[@]} -eq 0 ]; then
        echo "  未找到相關服務" >&2
        return 1
    fi

    while true; do
        read -p "$(echo -e ${YELLOW}請選擇要操作的服務編號 [1-${#services[@]}]，或按 s 跳過:${NC}) " selection
        if [[ "$selection" =~ ^[Ss]$ ]]; then
            return 1
        fi
        if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#services[@]}" ]; then
            echo "${services[$((selection-1))]}"
            return 0
        else
            echo -e "${RED}無效的選擇${NC}" >&2
        fi
    done
}

SELECTED_INSTALL_DIR=$(list_install_dirs)
if [ -z "$SELECTED_INSTALL_DIR" ]; then
    error "未選擇安裝目錄"
fi
PROJECT_DIR="$SELECTED_INSTALL_DIR"
log "已選擇安裝目錄: $PROJECT_DIR"

DEPLOY_CONFIG_FILE="${PROJECT_DIR}/deploy.config.sh"
if [ -f "$DEPLOY_CONFIG_FILE" ]; then
    source "$DEPLOY_CONFIG_FILE"
    log "已載入配置: $DEPLOY_CONFIG_FILE"
else
    INSTALL_DIR_NAME=$(basename "$PROJECT_DIR")
    BACKUP_DIR_NAME="${INSTALL_DIR_NAME}-backups"
    BACKUP_DIR="/srv/apps/${BACKUP_DIR_NAME}"
    warning "未找到配置文件，使用預設值"
fi

if [ ! -d "$BACKUP_DIR" ]; then
    BACKUP_DIR="${PROJECT_DIR}/backups"
fi

CURRENT_USER=${SUDO_USER:-$USER}
if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
    CURRENT_USER=$(whoami)
fi

SERVICE_NAME="${SERVICE_NAME:-}"
SERVICE_WAS_RUNNING=0

confirm() {
    if [ -n "$NON_INTERACTIVE" ]; then
        log "非交互式模式，自動確認"
        return 0
    fi
    read -p "$(echo -e ${YELLOW}$1${NC}) [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1
    fi
    return 0
}

echo "============================================"
echo "  維護巡檢報告系統"
echo "  還原程式"
echo "============================================"
echo ""

declare -a BACKUP_FILES_ARRAY

list_backups() {
    BACKUP_FILES_ARRAY=()
    while IFS= read -r file; do
        [ -f "$file" ] && BACKUP_FILES_ARRAY+=("$file")
    done < <(find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name "backup_*.tar.gz" -o -name "uninstall_backup_*.tar.gz" \) 2>/dev/null | sort -r)

    if [ ${#BACKUP_FILES_ARRAY[@]} -eq 0 ]; then
        echo "  無備份檔案"
        return 1
    fi

    echo "可用的備份檔案："
    local index=1
    for file in "${BACKUP_FILES_ARRAY[@]}"; do
        local size=$(du -h "$file" | cut -f1)
        printf "  [%2d] %s (大小: %s)\n" "$index" "$(basename "$file")" "$size"
        ((index++))
    done
    return 0
}

if [ -z "$1" ]; then
    if ! list_backups; then
        error "沒有可用的備份檔案"
    fi
    echo ""
    if [ -n "$NON_INTERACTIVE" ]; then
        BACKUP_FILE="${BACKUP_FILES_ARRAY[0]}"
        log "非交互式模式，自動選擇最新備份: $(basename "$BACKUP_FILE")"
    else
        while true; do
            read -p "$(echo -e ${YELLOW}請選擇要還原的備份編號 [1-${#BACKUP_FILES_ARRAY[@]}]，或按 q 取消:${NC}) " selection
            if [[ "$selection" =~ ^[Qq]$ ]]; then
                log "還原操作已取消"
                exit 0
            fi
            if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#BACKUP_FILES_ARRAY[@]}" ]; then
                BACKUP_FILE="${BACKUP_FILES_ARRAY[$((selection-1))]}"
                break
            fi
        done
    fi
else
    BACKUP_FILE="$1"
    if [[ "$BACKUP_FILE" != /* ]]; then
        if [ -f "${BACKUP_DIR}/${BACKUP_FILE}" ]; then
            BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILE}"
        elif [ -f "${PROJECT_DIR}/backups/${BACKUP_FILE}" ]; then
            BACKUP_FILE="${PROJECT_DIR}/backups/${BACKUP_FILE}"
        else
            error "備份檔案不存在: $BACKUP_FILE"
        fi
    fi
fi

if [ ! -f "$BACKUP_FILE" ]; then
    error "備份檔案不存在: $BACKUP_FILE"
fi

BACKUP_BYTES=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "0")
if [ "$BACKUP_BYTES" -eq 0 ]; then
    error "備份檔案大小為 0，檔案可能損壞"
fi
log "找到備份檔案: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

warning "還原操作將覆蓋現有的資料庫和上傳檔案！"
if ! confirm "確定要繼續還原嗎？"; then
    log "還原操作已取消"
    exit 0
fi

# 解壓備份檔案
TEMP_DIR="/tmp/maint_report_restore_$(date +'%Y%m%d_%H%M%S')"
mkdir -p "$TEMP_DIR" || error "無法創建臨時目錄"
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR" || error "備份檔案解壓失敗"

RESTORE_DIR=$(find "$TEMP_DIR" -maxdepth 1 -type d -name "backup_*" 2>/dev/null | head -n 1)
if [ -z "$RESTORE_DIR" ] && [ -d "$TEMP_DIR/temp_uninstall_backup" ]; then
    RESTORE_DIR="$TEMP_DIR/temp_uninstall_backup"
fi
if [ -z "$RESTORE_DIR" ]; then
    RESTORE_DIR="$TEMP_DIR"
fi
log "使用備份目錄: $RESTORE_DIR"

if [ -f "$RESTORE_DIR/backup_info.txt" ]; then
    cat "$RESTORE_DIR/backup_info.txt"
    echo ""
fi

# 選擇服務（用於停止/重啟）
if [ -z "$SERVICE_NAME" ]; then
    SELECTED_SERVICE=$(list_services) && SERVICE_NAME="$SELECTED_SERVICE"
fi

# 停止服務
if [ -n "$SERVICE_NAME" ] && systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service"; then
    if sudo systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        SERVICE_WAS_RUNNING=1
        log "停止服務以確保資料庫檔案安全還原..."
        sudo systemctl stop "${SERVICE_NAME}" 2>/dev/null || warning "無法停止服務"
        sleep 2
    fi
fi

# 還原資料庫
DB_SOURCE=""
if [ -f "$RESTORE_DIR/data/maint_report.db" ]; then
    DB_SOURCE="$RESTORE_DIR/data/maint_report.db"
elif [ -f "$RESTORE_DIR/maint_report.db" ]; then
    DB_SOURCE="$RESTORE_DIR/maint_report.db"
fi

if [ -n "$DB_SOURCE" ] && [ -f "$DB_SOURCE" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        TABLE_COUNT=$(sqlite3 "$DB_SOURCE" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
        if [ "$TABLE_COUNT" -eq 0 ]; then
            error "備份檔案中的資料庫無效：沒有資料表。請使用其他備份檔案。"
        fi
        log "✓ 備份檔案中的資料庫有效，包含 $TABLE_COUNT 個資料表"
    fi

    mkdir -p "${PROJECT_DIR}/data"
    if [ -f "${PROJECT_DIR}/data/maint_report.db" ]; then
        mv "${PROJECT_DIR}/data/maint_report.db" "${PROJECT_DIR}/data/maint_report.db.backup_$(date +'%Y%m%d_%H%M%S')" || warning "無法備份現有資料庫"
    fi

    rm -f "${PROJECT_DIR}/data/maint_report.db-wal" "${PROJECT_DIR}/data/maint_report.db-shm" 2>/dev/null || true
    cp "$DB_SOURCE" "${PROJECT_DIR}/data/maint_report.db" || error "資料庫還原失敗"
    sync 2>/dev/null || true
    chmod 644 "${PROJECT_DIR}/data/maint_report.db" || true
    chown "${CURRENT_USER}:${CURRENT_USER}" "${PROJECT_DIR}/data/maint_report.db" 2>/dev/null || true

    RESTORED_SIZE=$(stat -f%z "${PROJECT_DIR}/data/maint_report.db" 2>/dev/null || stat -c%s "${PROJECT_DIR}/data/maint_report.db" 2>/dev/null || echo "0")
    log "✓ 資料庫還原完成，大小: $RESTORED_SIZE bytes"
else
    warning "備份中沒有找到資料庫檔案，跳過資料庫還原"
fi

# 還原上傳檔案
if [ -d "$RESTORE_DIR/uploads" ] && [ "$(ls -A "$RESTORE_DIR/uploads" 2>/dev/null)" ]; then
    if [ -d "${PROJECT_DIR}/uploads" ] && [ "$(ls -A "${PROJECT_DIR}/uploads" 2>/dev/null)" ]; then
        mv "${PROJECT_DIR}/uploads" "${PROJECT_DIR}/uploads.backup_$(date +'%Y%m%d_%H%M%S')" || warning "無法備份現有上傳檔案"
    fi
    mkdir -p "${PROJECT_DIR}/uploads"
    cp -r "$RESTORE_DIR/uploads"/* "${PROJECT_DIR}/uploads/" 2>/dev/null || warning "部分上傳檔案還原失敗"
    chmod -R 755 "${PROJECT_DIR}/uploads" || true
    log "✓ 上傳檔案還原完成"
else
    info "備份中沒有上傳檔案，跳過"
fi

# 清理臨時目錄
rm -rf "$TEMP_DIR"

# 重啟服務
if [ "$SERVICE_WAS_RUNNING" -eq 1 ] && [ -n "$SERVICE_NAME" ]; then
    log "重新啟動服務..."
    sudo systemctl start "${SERVICE_NAME}" 2>/dev/null || warning "服務啟動失敗，請手動檢查"
    sleep 2
    if sudo systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        log "✓ 服務已重新啟動"
    else
        warning "服務可能未成功啟動，請執行: sudo systemctl status ${SERVICE_NAME}"
    fi
fi

echo ""
echo "============================================"
echo -e "${GREEN}  還原完成！${NC}"
echo "============================================"
echo ""
