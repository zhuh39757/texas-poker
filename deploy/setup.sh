#!/usr/bin/env bash
# 在 Linux 服务器上安装或更新德州扑克（需要 root，用 sudo 运行）
#
#   首次安装：sudo bash deploy/setup.sh --password 你的口令 [--port 3000]
#   更新代码：sudo bash deploy/setup.sh            （沿用上次的口令和端口）
#
# 设计原则：不碰服务器上原有的东西
#   - 自带一份 Node.js，装在 /opt/texas-poker/runtime，不改系统的 node
#   - 用专门的低权限用户 poker 运行，只能写自己的 data 目录
#   - 单独一个 systemd 服务 texas-poker，卸载用 deploy/uninstall.sh
set -euo pipefail

APP=/opt/texas-poker
ENV_FILE=/etc/texas-poker.env
SERVICE=texas-poker
NODE_VERSION=v24.21.0
NODE_MIRROR=https://cdn.npmmirror.com/binaries/node
NPM_REGISTRY=https://registry.npmmirror.com

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 sudo 运行：sudo bash $0 $*"
command -v systemctl >/dev/null || die "这台服务器没有 systemd，脚本不支持"

# ---------- 参数 ----------
PASSWORD=""
PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    *) die "不认识的参数 $1" ;;
  esac
done

# 更新时沿用上次的设置（命令行给了新值就用新的）
if [ -f "$ENV_FILE" ]; then
  PASSWORD="${PASSWORD:-$(sed -n 's/^POKER_PASSWORD=//p' "$ENV_FILE")}"
  PORT="${PORT:-$(sed -n 's/^PORT=//p' "$ENV_FILE")}"
fi
PORT="${PORT:-3000}"

[ -n "$PASSWORD" ] || die "第一次安装要设置房间口令：sudo bash $0 --password 你的口令"
[[ "$PASSWORD" =~ ^[A-Za-z0-9_-]{4,32}$ ]] || die "口令只能用 4–32 位字母、数字、下划线或减号"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "端口要在 1024–65535 之间"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/server/index.js" ] || die "找不到代码，请在解压后的项目目录里运行"

# ---------- 端口检查 ----------
systemctl stop "$SERVICE" 2>/dev/null || true
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  die "端口 $PORT 已经被别的程序占用了，换一个：sudo bash $0 --port 3100"
fi

# ---------- 1. 复制代码（保留已有的计分数据）----------
say "复制代码到 $APP"
mkdir -p "$APP"
if [ "$SRC" != "$APP" ]; then
  for item in server public tools deploy package.json package-lock.json .npmrc; do
    [ -e "$SRC/$item" ] || continue
    rm -rf "${APP:?}/$item"
    cp -r "$SRC/$item" "$APP/"
  done
fi
mkdir -p "$APP/data"

# ---------- 2. 私有的 Node.js ----------
NODE="$APP/runtime/node/bin/node"
if [ ! -x "$NODE" ] || [ "$("$NODE" -v)" != "$NODE_VERSION" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "不支持的 CPU 架构 $(uname -m)" ;;
  esac
  FILE="node-$NODE_VERSION-linux-$ARCH.tar.gz"
  TMP="$(mktemp -d)"
  say "下载 Node.js $NODE_VERSION（$ARCH）"
  curl -fL --retry 3 --connect-timeout 20 -o "$TMP/$FILE" "$NODE_MIRROR/$NODE_VERSION/$FILE"
  # 校验值优先从官网取，取不到再用镜像
  curl -fsS --max-time 20 -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" \
    || curl -fsS --max-time 20 -o "$TMP/SHASUMS256.txt" "$NODE_MIRROR/$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js 安装包校验失败"
  rm -rf "$APP/runtime/node"
  mkdir -p "$APP/runtime/node"
  tar -xzf "$TMP/$FILE" -C "$APP/runtime/node" --strip-components=1
  rm -rf "$TMP"
fi
"$NODE" -v

# ---------- 3. 依赖 ----------
say "安装依赖"
cd "$APP"
PATH="$APP/runtime/node/bin:$PATH" npm install --omit=dev --no-fund --no-audit --registry="$NPM_REGISTRY"

# ---------- 4. 运行用户和权限 ----------
id poker >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin poker
chown -R root:root "$APP"
chown -R poker:poker "$APP/data"
chmod -R a+rX "$APP"

# ---------- 5. 配置和服务 ----------
say "注册系统服务 $SERVICE"
umask 077
cat > "$ENV_FILE" <<EOF
PORT=$PORT
POKER_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE"
umask 022

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Texas Poker (friends game)
After=network.target

[Service]
User=poker
Group=poker
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=$NODE server/index.js
Restart=always
RestartSec=3
# 只允许写自己的数据目录，其余文件系统只读，碰不到服务器上别的东西
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$APP/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"

# ---------- 6. 本机防火墙（只在已经启用时放行）----------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" >/dev/null && echo "已在 ufw 放行 $PORT/tcp"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null && echo "已在 firewalld 放行 $PORT/tcp"
fi

# ---------- 7. 检查是否真的跑起来了 ----------
sleep 2
systemctl is-active --quiet "$SERVICE" || { journalctl -u "$SERVICE" -n 30 --no-pager; die "服务没有启动成功，上面是日志"; }
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/info" >/dev/null || die "服务启动了但访问不到，看日志：journalctl -u $SERVICE -n 50"

IP="$(curl -fsS --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null \
  || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '服务器公网IP')"
say "部署完成"
cat <<EOF
  地址：http://$IP:$PORT
  口令：$PASSWORD

  还差一步：到腾讯云控制台放行 TCP $PORT 端口
    轻量应用服务器：实例详情 → 防火墙 → 添加规则
    云服务器 CVM：  安全组 → 入站规则 → 添加规则

  常用命令：
    看日志   journalctl -u $SERVICE -f
    重启     sudo systemctl restart $SERVICE
    卸载     sudo bash $APP/deploy/uninstall.sh
EOF
