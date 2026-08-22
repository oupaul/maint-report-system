#!/bin/bash
# 維護巡檢報告系統 - 備份腳本

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()     { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[錯誤]${NC} $1"; exit 1; }
warning() { echo -e "${YELLOW}[警告]${NC} $1"; }
info()    { echo -e "${BLUE}[資訊]${NC} $1"; }

# 列出 /srv/apps 下可能的安裝目錄
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

    if [ -f "${SCRIPT_DIR}/package.json" ]; then
        local already_in_list=false
        for dir in "${dirs[@]}"; do
            if [ "$dir" = "$SCRIPT_DIR" ]; then
                already_in_list=true
                break
            fi
        done
        if [ "$already_in_list" = false ] && [[ "$SCRIPT_DIR" != /srv/apps/* ]]; then
            dirs+=("$SCRIPT_DIR")
            local size=$(du -sh "$SCRIPT_DIR" 2>/dev/null | cut -f1 || echo "未知")
            printf "  [%2d] %s (當前目錄, 大小: %s)\n" "$index" "$SCRIPT_DIR" "$size" >&2
            ((index++))
        fi
    fi

    if [ ${#dirs[@]} -eq 0 ]; then
        echo "  未找到安裝目錄" >&2
        return 1
    fi

    while true; do
        read -p "$(echo -e ${YELLOW}請選擇要備份的安裝目錄編號 [1-${#dirs[@]}]，或按 q 取消:${NC}) " selection
        if [[ "$selection" =~ ^[Qq]$ ]]; then
            log "備份操作已取消" >&2
            exit 0
        fi
        if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#dirs[@]}" ]; then
            echo "${dirs[$((selection-1))]}"
            return 0
        else
            echo -e "${RED}無效的選擇，請輸入 1-${#dirs[@]} 之間的數字，或按 q 取消${NC}" >&2
        fi
    done
}

if [ -n "$NON_INTERACTIVE" ] || [ ! -t 0 ]; then
    if [ -f "${SCRIPT_DIR}/package.json" ]; then
        SELECTED_INSTALL_DIR="$SCRIPT_DIR"
        log "非交互模式，自動選擇安裝目錄: $SELECTED_INSTALL_DIR"
    elif [ -d "/srv/apps/maint-report-system" ] && [ -f "/srv/apps/maint-report-system/package.json" ]; then
        SELECTED_INSTALL_DIR="/srv/apps/maint-report-system"
        log "非交互模式，自動選擇安裝目錄: $SELECTED_INSTALL_DIR"
    else
        error "非交互模式下無法確定安裝目錄"
    fi
else
    SELECTED_INSTALL_DIR=$(list_install_dirs)
    if [ -z "$SELECTED_INSTALL_DIR" ]; then
        error "未選擇安裝目錄"
    fi
fi

PROJECT_DIR="$SELECTED_INSTALL_DIR"
log "已選擇安裝目錄: $PROJECT_DIR"

DEPLOY_CONFIG_FILE="${PROJECT_DIR}/deploy.config.sh"
if [ -f "$DEPLOY_CONFIG_FILE" ]; then
    source "$DEPLOY_CONFIG_FILE"
    log "已載入配置: $DEPLOY_CONFIG_FILE"
    USE_INSTALL_BACKUP_DIR=1
else
    INSTALL_DIR_NAME=$(basename "$PROJECT_DIR")
    BACKUP_DIR_NAME="${INSTALL_DIR_NAME}-backups"
    BACKUP_DIR="/srv/apps/${BACKUP_DIR_NAME}"
    USE_INSTALL_BACKUP_DIR=1
    warning "未找到配置文件，使用預設值"
fi

if [ "$USE_INSTALL_BACKUP_DIR" -eq 1 ]; then
    if [ "$EUID" -eq 0 ]; then
        mkdir -p "$BACKUP_DIR"
        chmod 755 "$BACKUP_DIR" || true
    else
        mkdir -p "$BACKUP_DIR" 2>/dev/null || true
    fi
else
    BACKUP_DIR="${PROJECT_DIR}/backups"
fi

TIMESTAMP=$(date +'%Y%m%d_%H%M%S')
BACKUP_NAME="backup_${TIMESTAMP}"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_NAME}"

echo "============================================"
echo "  維護巡檢報告系統"
echo "  備份程式"
echo "============================================"
echo ""

log "開始備份流程..."

if [ ! -d "$PROJECT_DIR" ]; then
    error "專案目錄不存在: $PROJECT_DIR"
fi

mkdir -p "$BACKUP_DIR" || error "無法創建備份目錄"
log "備份目錄: $BACKUP_DIR"

mkdir -p "$BACKUP_PATH" || error "無法創建備份目錄: $BACKUP_PATH"
log "備份名稱: $BACKUP_NAME"

# 備份資料庫
log "備份資料庫..."
DB_FILE="${PROJECT_DIR}/data/maint_report.db"
if [ -f "$DB_FILE" ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        log "執行 WAL checkpoint（合併 WAL 到主檔案）..."
        sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || warning "WAL checkpoint 失敗，但繼續備份"
    fi

    DB_FILE_SIZE=$(stat -f%z "$DB_FILE" 2>/dev/null || stat -c%s "$DB_FILE" 2>/dev/null || echo "0")
    if [ "$DB_FILE_SIZE" -lt 1000 ]; then
        warning "資料庫檔案過小 (${DB_FILE_SIZE} bytes)，可能為空或損壞"
    fi

    mkdir -p "${BACKUP_PATH}/data"
    cp "$DB_FILE" "${BACKUP_PATH}/data/maint_report.db" || error "資料庫備份失敗"

    BACKUP_DB_SIZE=$(stat -f%z "${BACKUP_PATH}/data/maint_report.db" 2>/dev/null || stat -c%s "${BACKUP_PATH}/data/maint_report.db" 2>/dev/null || echo "0")
    if [ "$BACKUP_DB_SIZE" -ne "$DB_FILE_SIZE" ]; then
        error "資料庫備份失敗：檔案大小不一致 (原始: ${DB_FILE_SIZE}, 備份: ${BACKUP_DB_SIZE})"
    fi

    DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
    log "資料庫備份完成，大小: $DB_SIZE"

    if command -v sqlite3 >/dev/null 2>&1; then
        log "驗證備份檔案內容..."
        BATCH_COUNT=$(sqlite3 "${BACKUP_PATH}/data/maint_report.db" "SELECT COUNT(*) FROM inspection_batches;" 2>/dev/null || echo "0")
        ASSET_COUNT=$(sqlite3 "${BACKUP_PATH}/data/maint_report.db" "SELECT COUNT(*) FROM assets;" 2>/dev/null || echo "0")
        ITEM_COUNT=$(sqlite3 "${BACKUP_PATH}/data/maint_report.db" "SELECT COUNT(*) FROM inspection_items;" 2>/dev/null || echo "0")
        USER_COUNT=$(sqlite3 "${BACKUP_PATH}/data/maint_report.db" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")

        log "備份資料統計："
        log "  - 巡檢批次: $BATCH_COUNT 筆"
        log "  - 資產: $ASSET_COUNT 筆"
        log "  - 檢查紀錄: $ITEM_COUNT 筆"
        log "  - 使用者: $USER_COUNT 筆"
    fi
else
    warning "資料庫檔案不存在: $DB_FILE"
fi

# 備份上傳檔案
log "備份上傳檔案..."
UPLOADS_DIR="${PROJECT_DIR}/uploads"
if [ -d "$UPLOADS_DIR" ] && [ "$(ls -A $UPLOADS_DIR 2>/dev/null)" ]; then
    mkdir -p "${BACKUP_PATH}/uploads"
    cp -r "$UPLOADS_DIR"/* "${BACKUP_PATH}/uploads/" 2>/dev/null || warning "部分上傳檔案備份失敗"
    UPLOADS_COUNT=$(find "$UPLOADS_DIR" -type f | wc -l)
    log "上傳檔案備份完成，檔案數: $UPLOADS_COUNT"
else
    info "上傳目錄為空或不存在，跳過備份"
fi

# 備份 package.json（用於還原時確認版本）
cp "${PROJECT_DIR}/package.json" "${BACKUP_PATH}/package.json" 2>/dev/null || warning "package.json 備份失敗"
if [ -f "${PROJECT_DIR}/package-lock.json" ]; then
    cp "${PROJECT_DIR}/package-lock.json" "${BACKUP_PATH}/package-lock.json" || warning "package-lock.json 備份失敗"
fi

# 建立備份資訊
BACKUP_INFO="${BACKUP_PATH}/backup_info.txt"
cat > "$BACKUP_INFO" << EOF
備份時間: $(date +'%Y-%m-%d %H:%M:%S')
備份名稱: $BACKUP_NAME
系統資訊:
  - 作業系統: $(uname -a)
  - Node.js 版本: $(node -v 2>/dev/null || echo "未安裝")
專案資訊:
  - 專案目錄: $PROJECT_DIR
  - 資料庫檔案: $DB_FILE
備份內容:
  - 資料庫: data/maint_report.db
  - 上傳檔案: uploads/
  - 套件資訊: package.json, package-lock.json
EOF

# 壓縮備份
log "壓縮備份檔案..."
cd "$BACKUP_DIR"
tar -czf "${BACKUP_NAME}.tar.gz" "$BACKUP_NAME" || error "備份壓縮失敗"
rm -rf "$BACKUP_NAME" || warning "無法刪除臨時備份目錄"
BACKUP_SIZE=$(du -h "${BACKUP_NAME}.tar.gz" | cut -f1)
log "備份壓縮完成，大小: $BACKUP_SIZE"

# 清理舊備份（保留最近 10 個）
log "清理舊備份..."
BACKUP_COUNT=$(ls -1t "${BACKUP_DIR}"/backup_*.tar.gz 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 10 ]; then
    OLD_BACKUPS=$(ls -1t "${BACKUP_DIR}"/backup_*.tar.gz | tail -n +11)
    for old_backup in $OLD_BACKUPS; do
        rm -f "$old_backup"
        log "已刪除舊備份: $(basename $old_backup)"
    done
else
    info "備份數量: $BACKUP_COUNT，無需清理"
fi

echo ""
echo "============================================"
echo -e "${GREEN}  備份完成！${NC}"
echo "============================================"
echo ""
info "備份檔案: ${BACKUP_NAME}.tar.gz"
info "備份大小: $BACKUP_SIZE"
info "備份位置: $BACKUP_DIR"
echo ""
echo "還原備份："
echo "  ./restore.sh ${BACKUP_NAME}.tar.gz"
echo ""
