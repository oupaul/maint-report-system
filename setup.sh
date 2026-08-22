#!/bin/bash
# 維護巡檢報告系統 - 全新主機一鍵安裝（從 GitHub）
#
# 用法：
#   公開 Repo:
#     bash <(curl -fsSL https://raw.githubusercontent.com/your-org/maint-report-system/main/setup.sh)
#
#   私有 Repo（curl 本身也需帶 token，支援 ghp_ 與 github_pat_ 格式）:
#     export GH_TOKEN=github_pat_xxxxxxxxxxxx   # 或 ghp_xxxxxxxxxxxx
#     bash <(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#       https://raw.githubusercontent.com/your-org/maint-report-system/main/setup.sh)
#
# 部署前請將下方 GITHUB_USER / GITHUB_REPO 換成實際的 repo。

set -e

GITHUB_USER="your-org"
GITHUB_REPO="maint-report-system"
BRANCH="${DEPLOY_BRANCH:-main}"
CLONE_DIR="/tmp/maint-report-setup-$$"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()     { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
error()   { echo -e "${RED}[錯誤]${NC} $1"; exit 1; }
warning() { echo -e "${YELLOW}[警告]${NC} $1"; }

echo ""
echo "============================================"
echo "  維護巡檢報告系統 - 從 GitHub 全新安裝"
echo "  Repo : https://github.com/${GITHUB_USER}/${GITHUB_REPO}"
echo "  Branch: ${BRANCH}"
echo "============================================"
echo ""

if [ "$EUID" -ne 0 ]; then
    error "請使用 sudo 執行：\n  sudo bash <(curl -fsSL ...)"
fi

if ! command -v git &>/dev/null; then
    log "安裝 git..."
    apt-get update -qq && apt-get install -y -qq git || error "git 安裝失敗，請手動執行：apt-get install -y git"
fi
log "✓ git $(git --version | awk '{print $3}')"

if [ -n "$GH_TOKEN" ]; then
    GIT_URL="https://${GH_TOKEN}@github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
    log "使用 GH_TOKEN 進行認證"
else
    GIT_URL="https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
fi

log "正在從 GitHub 下載（branch: ${BRANCH}）..."
if ! git clone --depth=1 -b "$BRANCH" "$GIT_URL" "$CLONE_DIR" 2>&1; then
    echo ""
    error "下載失敗。可能原因：
  1. Repo 為私有 → 請設定 GH_TOKEN：
       export GH_TOKEN=ghp_xxxxxxxxxxxx
       bash <(curl -fsSL ...)
  2. Branch '${BRANCH}' 不存在 → 請確認 branch 名稱
  3. 網路問題 → 請確認伺服器可存取 github.com"
fi
log "✓ 下載完成：${CLONE_DIR}"

chmod +x "${CLONE_DIR}/deploy.sh"

log "啟動部署腳本..."
echo ""
exec sudo bash "${CLONE_DIR}/deploy.sh"
