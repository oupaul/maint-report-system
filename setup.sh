#!/bin/bash
# 維護巡檢報告系統 - 全新主機一鍵安裝（從 GitHub）
#
# 用法：
#   公開 Repo:
#     curl -fsSL https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh -o /tmp/setup.sh && sudo bash /tmp/setup.sh
#   （不要用 sudo bash <(curl ...)：/dev/fd 不會傳給 sudo；也不要 curl | sudo bash，部署有互動提問）
#
#   私有 Repo（curl 本身也需帶 token，支援 ghp_ 與 github_pat_ 格式）:
#     export GH_TOKEN=github_pat_xxxxxxxxxxxx   # 或 ghp_xxxxxxxxxxxx
#     curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
#       https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh -o /tmp/setup.sh \
#       && sudo --preserve-env=GH_TOKEN bash /tmp/setup.sh

set -e

GITHUB_USER="oupaul"
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
    error "請使用 sudo 執行（先下載成檔案，不要用 sudo bash <(curl ...)）：\n  curl -fsSL https://raw.githubusercontent.com/oupaul/maint-report-system/main/setup.sh -o /tmp/setup.sh && sudo bash /tmp/setup.sh"
fi

if ! command -v git &>/dev/null; then
    log "安裝 git..."
    apt-get update -qq && apt-get install -y -qq git || error "git 安裝失敗，請手動執行：apt-get install -y git"
fi
log "✓ git $(git --version | awk '{print $3}')"

# token 不放進 clone URL（會留在 .git/config 與程序參數裡），改成只在這一次
# git 呼叫以 extraHeader 帶入，跟 update.sh 做法一致。
GIT_URL="https://github.com/${GITHUB_USER}/${GITHUB_REPO}.git"
GIT_AUTH_ARGS=()
if [ -n "${GH_TOKEN:-}" ]; then
    GIT_AUTH_ARGS=(-c "http.extraHeader=Authorization: Bearer ${GH_TOKEN}")
    log "使用 GH_TOKEN 進行認證"
fi

log "正在從 GitHub 下載（branch: ${BRANCH}）..."
if ! git "${GIT_AUTH_ARGS[@]}" clone --depth=1 -b "$BRANCH" "$GIT_URL" "$CLONE_DIR" 2>&1; then
    echo ""
    error "下載失敗。可能原因：
  1. Repo 為私有 → 請設定 GH_TOKEN：
       export GH_TOKEN=ghp_xxxxxxxxxxxx
       並以 sudo --preserve-env=GH_TOKEN bash /tmp/setup.sh 重新執行
  2. Branch '${BRANCH}' 不存在 → 請確認 branch 名稱
  3. 網路問題 → 請確認伺服器可存取 github.com"
fi
log "✓ 下載完成：${CLONE_DIR}"

chmod +x "${CLONE_DIR}/deploy.sh"

log "啟動部署腳本..."
echo ""
# 本腳本執行到這裡已經保證是 root（上方 EUID 檢查），不需要也不能再包一層 sudo：
# 從已經是 root 的行程再呼叫一次 sudo，sudo 會把 $SUDO_USER 重設成 root（而不是
# 保留原本從一般帳號 sudo 進來時的使用者），deploy.sh 判斷「是否以 root 身份執行
# 服務」的檢查就會誤判失敗。直接執行即可自然繼承目前環境變數（含 $SUDO_USER）。
exec bash "${CLONE_DIR}/deploy.sh"
