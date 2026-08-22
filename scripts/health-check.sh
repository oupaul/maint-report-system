#!/bin/bash
# 健康檢查腳本：確認服務是否正常回應
#
# 用法：
#   scripts/health-check.sh <PORT> [MAX_RETRIES] [RETRY_DELAY_SECONDS]
#
# 檢查 GET /login（全站唯一不需要登入即可存取、且會回應固定狀態碼的頁面）
# 是否回傳 HTTP 200。不需要帳號密碼，適合部署腳本或人工手動驗證使用。
#
# 範例：
#   scripts/health-check.sh 3000
#   scripts/health-check.sh 3000 20 5   # 最多重試 20 次，每次間隔 5 秒

set -euo pipefail

PORT="${1:?用法: health-check.sh <PORT> [MAX_RETRIES] [RETRY_DELAY_SECONDS]}"
MAX_RETRIES="${2:-10}"
RETRY_DELAY="${3:-3}"
URL="http://127.0.0.1:${PORT}/login"

for i in $(seq 1 "$MAX_RETRIES"); do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL" 2>/dev/null || echo "000")
    if [ "$STATUS" = "200" ]; then
        echo "✓ 健康檢查通過（${URL} 回傳 200，第 ${i} 次嘗試）"
        exit 0
    fi
    echo "健康檢查第 ${i}/${MAX_RETRIES} 次失敗（HTTP ${STATUS}）$( [ "$i" -lt "$MAX_RETRIES" ] && echo "，${RETRY_DELAY}s 後重試..." )"
    if [ "$i" -lt "$MAX_RETRIES" ]; then
        sleep "$RETRY_DELAY"
    fi
done

echo "✗ 健康檢查失敗：${URL} 在 $((MAX_RETRIES * RETRY_DELAY)) 秒內未回傳 200" >&2
exit 1
