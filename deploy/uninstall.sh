#!/usr/bin/env bash
# 卸载德州扑克：sudo bash /opt/texas-poker/deploy/uninstall.sh
# 计分数据会先备份到 /root/，其余全部删干净
set -euo pipefail

APP=/opt/texas-poker
SERVICE=texas-poker

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

PORT="$(sed -n 's/^PORT=//p' /etc/texas-poker.env 2>/dev/null || true)"

systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE.service" /etc/texas-poker.env
systemctl daemon-reload

if [ -f "$APP/data/db.json" ]; then
  BACKUP="/root/texas-poker-db-$(date +%Y%m%d-%H%M%S).json"
  cp "$APP/data/db.json" "$BACKUP"
  echo "计分数据已备份到 $BACKUP"
fi

rm -rf "$APP"
userdel poker 2>/dev/null || true

echo "已卸载。"
[ -n "$PORT" ] && echo "如果不再需要，可以到腾讯云控制台把 TCP $PORT 端口的放行规则删掉。"
exit 0
