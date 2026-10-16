#!/usr/bin/env bash
# 免 sudo 安装：全部装在当前用户的家目录里，用 systemd 用户服务运行
# 适合在别人的服务器上借一个普通账号部署
#
#   首次安装：bash deploy/setup-user.sh --password 你的口令 [--port 3000]
#   更新代码：bash deploy/setup-user.sh            （沿用上次的口令和端口）
#
# 前提：服务器主人执行过一次 sudo loginctl enable-linger <你的用户名>
#      （否则你一退出登录程序就停了，服务器重启也不会自动启动）
set -euo pipefail

APP="$HOME/texas-poker"
ENV_FILE="$HOME/.config/texas-poker.env"
UNIT_DIR="$HOME/.config/systemd/user"
SERVICE=texas-poker
NODE_VERSION=v24.21.0
NODE_MIRROR=https://cdn.npmmirror.com/binaries/node
NPM_REGISTRY=https://registry.npmmirror.com
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

say() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "这个脚本给普通用户用；有 root 权限请用 deploy/setup.sh"
systemctl --user is-system-running >/dev/null 2>&1 || [ "$(systemctl --user is-system-running 2>/dev/null)" = degraded ] \
  || die "用不了 systemd 用户服务（systemctl --user）"
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '=yes' \
  || die "需要服务器主人先执行：sudo loginctl enable-linger $USER"

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
if [ -f "$ENV_FILE" ]; then
  PASSWORD="${PASSWORD:-$(sed -n 's/^POKER_PASSWORD=//p' "$ENV_FILE")}"
  PORT="${PORT:-$(sed -n 's/^PORT=//p' "$ENV_FILE")}"
fi
PORT="${PORT:-3000}"
[ -n "$PASSWORD" ] || die "第一次安装要设置房间口令：bash $0 --password 你的口令"
[[ "$PASSWORD" =~ ^[A-Za-z0-9_-]{4,32}$ ]] || die "口令只能用 4–32 位字母、数字、下划线或减号"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "端口要在 1024–65535 之间"

SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/server/index.js" ] || die "找不到代码，请在解压后的项目目录里运行"

# ---------- 端口检查 ----------
systemctl --user stop "$SERVICE" 2>/dev/null || true
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
  die "端口 $PORT 已经被别的程序占用了，换一个：bash $0 --port 3100"
fi

# ---------- 1. 复制代码（保留已有的计分数据）----------
say "复制代码到 $APP"
mkdir -p "$APP/data"
if [ "$SRC" != "$APP" ]; then
  for item in server public tools deploy package.json package-lock.json .npmrc; do
    [ -e "$SRC/$item" ] || continue
    rm -rf "${APP:?}/$item"
    cp -r "$SRC/$item" "$APP/"
  done
fi
chmod 700 "$APP"

# ---------- 2. 私有的 Node.js（不用、也不碰系统里的 node）----------
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

# ---------- 4. 配置和服务 ----------
say "注册用户服务 $SERVICE"
mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR"
(umask 077 && printf 'PORT=%s\nPOKER_PASSWORD=%s\n' "$PORT" "$PASSWORD" > "$ENV_FILE")

cat > "$UNIT_DIR/$SERVICE.service" <<'EOF'
[Unit]
Description=Texas Poker (friends game)
After=network-online.target

[Service]
WorkingDirectory=%h/texas-poker
EnvironmentFile=%h/.config/texas-poker.env
# 限制内存，避免影响服务器主人自己的程序
ExecStart=%h/texas-poker/runtime/node/bin/node --max-old-space-size=256 server/index.js
Restart=always
RestartSec=3
MemoryMax=400M
TasksMax=64
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"

# ---------- 5. 检查是否真的跑起来了 ----------
sleep 2
systemctl --user is-active --quiet "$SERVICE" || { journalctl --user -u "$SERVICE" -n 30 --no-pager; die "服务没有启动成功，上面是日志"; }
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/info" >/dev/null || die "服务启动了但访问不到，看日志：journalctl --user -u $SERVICE -n 50"

IP="$(curl -fsS --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null \
  || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '服务器公网IP')"
say "部署完成"
cat <<EOF
  地址：http://$IP:$PORT   （服务器主人要在腾讯云防火墙放行 TCP $PORT）
  口令：$PASSWORD

  常用命令：
    看日志   journalctl --user -u $SERVICE -f
    重启     systemctl --user restart $SERVICE
    卸载     bash $APP/deploy/uninstall-user.sh
EOF
