#!/bin/bash
# 設定系統自動備份 - 使用 Systemd Timer
# 此腳本會由 deploy.sh 調用，或可單獨執行

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}[錯誤]${NC} 需要 root 權限，請使用 sudo 執行"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_CONFIG_FILE="${SCRIPT_DIR}/deploy.config.sh"
if [ ! -f "$DEPLOY_CONFIG_FILE" ] && [ -f "/srv/apps/maint-report-system/deploy.config.sh" ]; then
    DEPLOY_CONFIG_FILE="/srv/apps/maint-report-system/deploy.config.sh"
fi

if [ -f "$DEPLOY_CONFIG_FILE" ]; then
    source "$DEPLOY_CONFIG_FILE"
    if [ -z "$INSTALL_DIR" ] && [ -n "$INSTALL_DIR_NAME" ]; then
        INSTALL_DIR="/srv/apps/${INSTALL_DIR_NAME}"
    fi
    if [ -z "$BACKUP_DIR" ] && [ -n "$BACKUP_DIR_NAME" ]; then
        BACKUP_DIR="/srv/apps/${BACKUP_DIR_NAME}"
    fi
    if [ -z "$SERVICE_NAME" ]; then
        SERVICE_NAME="maint-report-system"
    fi
else
    INSTALL_DIR="/srv/apps/maint-report-system"
    BACKUP_DIR="/srv/apps/maint-report-system-backups"
    SERVICE_NAME="maint-report-system"
fi

BACKUP_SCRIPT="${INSTALL_DIR}/backup.sh"
if [ ! -f "$BACKUP_SCRIPT" ]; then
    BACKUP_SCRIPT="${SCRIPT_DIR}/backup.sh"
fi
BACKUP_SERVICE_NAME="${SERVICE_NAME}-backup"

if [ ! -f "$BACKUP_SCRIPT" ]; then
    echo -e "${RED}[錯誤]${NC} 找不到備份腳本: $BACKUP_SCRIPT"
    exit 1
fi

chmod +x "$BACKUP_SCRIPT"

echo "============================================"
echo "  設定系統自動備份（Systemd Timer）"
echo "============================================"
echo ""

if [ $# -ge 1 ]; then
    SCHEDULE_OPTION="$1"
    CUSTOM_TIME="${2:-}"
else
    echo "請選擇自動備份頻率："
    echo ""
    echo "  1) 每日備份 - 每天凌晨 2:00"
    echo "  2) 每週備份 - 每週日凌晨 2:00"
    echo "  3) 每日兩次 - 每天 2:00 和 14:00"
    echo "  4) 進階自訂 - 使用 systemd OnCalendar 格式"
    echo "  5) 停用自動備份"
    echo "  6) 每日自訂時間 - 輸入 時:分（如 03:30 表示每天 3:30）"
    echo ""
    read -p "請輸入選項 [1-6]: " SCHEDULE_OPTION
fi

case "$SCHEDULE_OPTION" in
    1)
        ON_CALENDAR_TIME="*-*-* 02:00:00"
        DESCRIPTION="每日凌晨 2:00 自動備份"
        ;;
    2)
        ON_CALENDAR_TIME="Sun *-*-* 02:00:00"
        DESCRIPTION="每週日凌晨 2:00 自動備份"
        ;;
    3)
        ON_CALENDAR_TIME="*-*-* 02,14:00:00"
        DESCRIPTION="每日 2:00 和 14:00 自動備份"
        ;;
    4)
        if [ -z "$CUSTOM_TIME" ]; then
            echo ""
            echo "自訂時間格式範例："
            echo "  *-*-* 03:00:00          # 每天凌晨 3:00"
            echo "  Mon,Wed,Fri 02:00:00    # 每週一、三、五凌晨 2:00"
            echo ""
            read -p "請輸入時間格式: " CUSTOM_TIME
        fi
        ON_CALENDAR_TIME="$CUSTOM_TIME"
        DESCRIPTION="自訂時間自動備份: $CUSTOM_TIME"
        ;;
    6)
        if [ -z "$CUSTOM_TIME" ]; then
            echo ""
            echo "請輸入每日備份時間（格式：時:分，24小時制，範例：03:30）"
            read -p "請輸入時間 [02:00]: " CUSTOM_TIME
            CUSTOM_TIME="${CUSTOM_TIME:-02:00}"
        fi
        if [[ "$CUSTOM_TIME" =~ ^([0-9]{1,2}):([0-5][0-9])$ ]]; then
            HOUR=$((10#${BASH_REMATCH[1]}))
            MIN=$((10#${BASH_REMATCH[2]}))
            if [ "$HOUR" -ge 0 ] 2>/dev/null && [ "$HOUR" -le 23 ] 2>/dev/null; then
                HOUR=$(printf "%02d" "$HOUR")
                MIN=$(printf "%02d" "$MIN")
                ON_CALENDAR_TIME="*-*-* ${HOUR}:${MIN}:00"
                DESCRIPTION="每日 ${HOUR}:${MIN} 自動備份"
            else
                echo -e "${RED}[錯誤]${NC} 小時需為 0-23"; exit 1
            fi
        else
            echo -e "${RED}[錯誤]${NC} 時間格式錯誤，請使用 時:分（如 03:30）"; exit 1
        fi
        ;;
    5)
        echo ""
        echo -e "${YELLOW}停用自動備份...${NC}"
        systemctl stop ${BACKUP_SERVICE_NAME}.timer 2>/dev/null || true
        systemctl disable ${BACKUP_SERVICE_NAME}.timer 2>/dev/null || true
        rm -f /etc/systemd/system/${BACKUP_SERVICE_NAME}.service
        rm -f /etc/systemd/system/${BACKUP_SERVICE_NAME}.timer
        systemctl daemon-reload
        echo -e "${GREEN}✓ 自動備份已停用${NC}"
        echo "您仍可手動執行備份：cd ${INSTALL_DIR} && sudo ./backup.sh"
        exit 0
        ;;
    *)
        echo -e "${RED}[錯誤]${NC} 無效的選項"
        exit 1
        ;;
esac

echo ""
echo "設定內容："
echo "  - 備份頻率: $DESCRIPTION"
echo "  - 備份腳本: $BACKUP_SCRIPT"
echo "  - 備份目錄: ${BACKUP_DIR}"
echo ""

cat > /etc/systemd/system/${BACKUP_SERVICE_NAME}.service <<EOF
[Unit]
Description=${SERVICE_NAME} Backup Service
After=network.target ${SERVICE_NAME}.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}
# 必須設定 NON_INTERACTIVE，否則 backup.sh 會進入互動模式等待選擇，導致排程備份失敗
ExecStart=/bin/bash -c 'NON_INTERACTIVE=1 exec '"${BACKUP_SCRIPT}"
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${BACKUP_SERVICE_NAME}
Nice=10
IOSchedulingClass=idle
EOF

cat > /etc/systemd/system/${BACKUP_SERVICE_NAME}.timer <<EOF
[Unit]
Description=${SERVICE_NAME} Backup Timer

[Timer]
OnCalendar=${ON_CALENDAR_TIME}
Persistent=true
RandomizedDelaySec=300
AccuracySec=1min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable ${BACKUP_SERVICE_NAME}.timer
systemctl restart ${BACKUP_SERVICE_NAME}.timer

echo ""
echo "============================================"
echo -e "${GREEN}  自動備份設定完成！${NC}"
echo "============================================"
echo ""
echo "設定資訊："
echo "  - 服務名稱: ${BACKUP_SERVICE_NAME}.service"
echo "  - Timer 名稱: ${BACKUP_SERVICE_NAME}.timer"
echo "  - 備份頻率: $DESCRIPTION"
echo ""
echo "管理命令："
echo "  查看 timer 狀態:    sudo systemctl status ${BACKUP_SERVICE_NAME}.timer"
echo "  立即執行備份:       sudo systemctl start ${BACKUP_SERVICE_NAME}.service"
echo "  查看備份日誌:       sudo journalctl -u ${BACKUP_SERVICE_NAME}.service -n 50"
echo "  停用自動備份:       sudo systemctl disable ${BACKUP_SERVICE_NAME}.timer"
echo ""
