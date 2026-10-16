#!/usr/bin/env bash
# 卸载（免 sudo 版）：bash ~/texas-poker/deploy/uninstall-user.sh
# 计分数据会先备份到家目录，其余全部删干净
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

APP="$HOME/texas-poker"
SERVICE=texas-poker

systemctl --user disable --now "$SERVICE" 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/$SERVICE.service" "$HOME/.config/texas-poker.env"
systemctl --user daemon-reload

if [ -f "$APP/data/db.json" ]; then
  BACKUP="$HOME/texas-poker-db-$(date +%Y%m%d-%H%M%S).json"
  cp "$APP/data/db.json" "$BACKUP"
  echo "计分数据已备份到 $BACKUP"
fi
rm -rf "$APP"
echo "已卸载。服务器主人可以到腾讯云控制台把对应端口的放行规则删掉。"
