#!/bin/bash
# 維護巡檢報告系統 - 從 GitHub 更新現有安裝
#
# 用法（在伺服器上）：
#   sudo /srv/apps/maint-report-system/update.sh          # 預設 branch (main)
#   sudo /srv/apps/maint-report-system/update.sh develop   # 指定 branch
#
# 或遠端一行指令（公開 Repo）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/your-org/maint-report-system/main/update.sh)
#
# 私有 Repo（curl 本身也需帶 token，支援 ghp_ 與 github_pat_ 格式）：
#   export GH_TOKEN=github_pat_xxxxxxxxxxxx   # 或 ghp_xxxxxxxxxxxx
#   bash <(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#     https://raw.githubusercontent.com/your-org/maint-report-system/main/update.sh)
#
# GH_TOKEN 只會以 git 單次呼叫的 extra header 傳遞，不會寫進暫存 clone
# 的 .git/config，暫存目錄結束時一律清除（含失敗中止的情況）。
#
# 預設會在同步程式碼前顯示目前/最新版本與 commit，並要求手動確認
# （建議先執行 sudo <安裝目錄>/backup.sh 確認有最新備份）。
# 全自動情境（例如排程）可設定 SKIP_UPDATE_CONFIRM=1 略過此確認。
#
# deploy.sh 執行失敗、或部署後健康檢查未通過，本腳本會停止並印出後續
# 排查方式，不會自動嘗試回滾或刪除任何資料。

set -euo pipefail

GITHUB_USER="your-org"
GITHUB_REPO="maint-report-system"
BRANCH="${1:-${DEPLOY_BRANCH:-main}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[錯誤]${NC} $1"; exit 1; }
warning() { echo -e "${YELLOW}[警告]${NC} $1"; }
info()    { echo -e "${BLUE}[資訊]${NC} $1"; }

echo ""
echo "============================================"
echo "  維護巡檢報告系統 - 從 GitHub 更新"
echo "  Repo  : https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
echo "  Branch: ${BRANCH}"
echo "============================================"
echo ""

if [ "$EUID" -ne 0 ]; then
    error "請使用 sudo 執行：sudo ./update.sh"
fi

# ── 偵測安裝目錄 ──────────────────────────────────────────────
detect_install_dir() {
    local unit
    unit=$(find /etc/systemd/system -maxdepth 1 -name "*.service" 2>/dev/null \
           | xargs grep -l "app.js" 2>/dev/null \
           | grep -v backup | head -1 || true)
    if [ -n "$unit" ]; then
        local app_path
        app_path=$(grep "ExecStart" "$unit" | grep -oP '(?<= )/[^ ]+/src/app\.js' | head -1 || true)
        if [ -n "$app_path" ]; then
            dirname "$(dirname "$app_path")"
            return 0
        fi
    fi

    local config
    config=$(find /srv/apps -maxdepth 2 -name "deploy.config.sh" 2>/dev/null | head -1 || true)
    if [ -n "$config" ]; then
        local dir
        dir=$(grep "^INSTALL_DIR=" "$config" 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d '"' || true)
        if [ -n "$dir" ] && [ -d "$dir" ]; then
            echo "$dir"
            return 0
        fi
    fi

    echo "/srv/apps/maint-report-system"
}

INSTALL_DIR=$(detect_install_dir)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/package.json" ] && [ -f "${SCRIPT_DIR}/deploy.sh" ]; then
    INSTALL_DIR="$SCRIPT_DIR"
fi

log "安裝目錄：${INSTALL_DIR}"

if [ ! -d "$INSTALL_DIR" ]; then
    error "安裝目錄不存在：${INSTALL_DIR}\n若尚未安裝，請先執行全新安裝：\n  bash <(curl -fsSL https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}/setup.sh)"
fi
if [ ! -f "${INSTALL_DIR}/package.json" ]; then
    error "${INSTALL_DIR} 不是有效的安裝目錄（找不到 package.json）"
fi

if ! command -v git &>/dev/null; then
    log "安裝 git..."
    apt-get update -qq && apt-get install -y -qq git || error "git 安裝失敗"
fi

GIT_URL="https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
GIT_AUTH_ARGS=()
if [ -n "${GH_TOKEN:-}" ]; then
    GIT_AUTH_ARGS=(-c "http.extraHeader=Authorization: Bearer ${GH_TOKEN}")
    log "使用 GH_TOKEN 進行認證"
fi

TMP="/tmp/maint-report-update-$$"
trap 'rm -rf "$TMP"' EXIT

log "從 GitHub 下載最新版本（branch: ${BRANCH}）..."
if ! git "${GIT_AUTH_ARGS[@]}" clone --depth=1 -b "$BRANCH" "$GIT_URL" "$TMP" 2>&1; then
    error "下載失敗。請確認：
  - 網路可存取 github.com
  - 若為私有 Repo，請設定 GH_TOKEN：export GH_TOKEN=ghp_xxxxxxxxxxxx"
fi
log "✓ 下載完成"

NEW_VERSION=$(grep '"version"' "$TMP/package.json" 2>/dev/null | head -1 | grep -oP '[\d.]+' | head -1 || echo "未知")
OLD_VERSION=$(grep '"version"' "$INSTALL_DIR/package.json" 2>/dev/null | head -1 | grep -oP '[\d.]+' | head -1 || echo "未知")
NEW_COMMIT=$(git -C "$TMP" rev-parse --short HEAD 2>/dev/null || echo "未知")
echo ""
info "來源：https://github.com/${GITHUB_USER}/${GITHUB_REPO} @ ${BRANCH} (${NEW_COMMIT})"
info "版本欄位：v${OLD_VERSION} → v${NEW_VERSION}（此欄位可能過時，實際內容以上方 commit 為準）"
echo ""

# ── 更新前確認（備份提醒）───────────────────────────────────────
if [ -z "${SKIP_UPDATE_CONFIRM:-}" ]; then
    warning "即將停止服務、同步程式碼，並執行資料庫 migration。"
    warning "deploy.sh 不會自動備份資料庫，程式碼本身也沒有自動回滾機制。"
    warning "建議先手動執行一次：sudo ${INSTALL_DIR}/backup.sh"
    read -p "$(echo -e ${YELLOW}確定要繼續更新嗎？${NC}) [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log "已取消更新，未做任何變更"
        exit 0
    fi
else
    info "SKIP_UPDATE_CONFIRM=1，略過更新前確認"
fi

# ── 同步程式碼（保留資料、上傳檔案、設定）─────────────────────
log "同步程式碼到 ${INSTALL_DIR}..."

RSYNC_EXCLUDES=(
    'node_modules/'
    '.git/'
    'data/'
    'uploads/'
    'backups/'
    'deploy.config.sh'
    '*.log'
    '*.db'
    '*.db-wal'
    '*.db-shm'
)

EXCLUDE_ARGS=()
for ex in "${RSYNC_EXCLUDES[@]}"; do
    EXCLUDE_ARGS+=("--exclude=${ex}")
done

if command -v rsync &>/dev/null; then
    rsync -a --delete "${EXCLUDE_ARGS[@]}" "${TMP}/" "${INSTALL_DIR}/" \
        || error "rsync 同步失敗"
else
    warning "rsync 未安裝，使用 cp 備援..."
    for d in src migrations scripts; do
        [ -d "${TMP}/$d" ] && cp -r "${TMP}/$d" "${INSTALL_DIR}/"
    done
    for f in package.json package-lock.json \
              deploy.sh restore.sh backup.sh setup.sh update.sh \
              uninstall.sh setup-backup-timer.sh; do
        [ -f "${TMP}/$f" ] && cp "${TMP}/$f" "${INSTALL_DIR}/$f"
    done
fi

log "✓ 程式碼同步完成"

# ── 執行增量部署（更新模式）─────────────────────────────────────
log "啟動部署腳本（增量更新模式）..."
echo ""
cd "${INSTALL_DIR}"
chmod +x deploy.sh

if ! sudo SKIP_BACKUP_PROMPT=1 bash deploy.sh; then
    error "deploy.sh 執行失敗，更新已停止。請檢查上方輸出。
  - 程式碼本身沒有自動回滾機制，如需恢復舊版本，需重新從舊的 tag/commit 手動部署
  - 服務日誌：sudo journalctl -u <service-name> -n 50"
fi

# ── 部署後健康檢查 ─────────────────────────────────────────────
log "部署腳本執行完成，開始部署後健康檢查..."
HEALTH_PORT=$(grep -E "^PORT=" "${INSTALL_DIR}/deploy.config.sh" 2>/dev/null | cut -d'=' -f2 | tr -d '"' || echo "3000")

if [ -f "${INSTALL_DIR}/scripts/health-check.sh" ]; then
    if bash "${INSTALL_DIR}/scripts/health-check.sh" "$HEALTH_PORT"; then
        log "✓ 健康檢查通過，更新完成"
    else
        error "健康檢查失敗：deploy.sh 回報成功，但服務未能在時限內正常回應（port ${HEALTH_PORT}）。
  請立即檢查：
    sudo systemctl status <service-name>
    sudo journalctl -u <service-name> -n 50
  本腳本不會自動回滾，請視情況手動處理。"
    fi
else
    warning "找不到 scripts/health-check.sh，略過部署後健康檢查"
    log "更新流程完成（未經健康檢查驗證）"
fi
