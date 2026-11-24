#!/bin/bash
# 写作台启动器：先拉起本地服务，再用 Chromium 以「Xwayland」模式打开窗口
# 用 x11 而不是 wayland，是因为 fcitx4 在原生 Wayland 应用里靠桥接工作，容易卡顿/丢焦点
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${NOVEL_PORT:-7788}"
URL="http://127.0.0.1:${PORT}/"
CHROME="/opt/apps/org.chromium.www/files/bin/chromium-browser"

# 1) 服务是否已在跑
if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  setsid node "$DIR/server.js" > /tmp/novel-writer.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -s -o /dev/null --max-time 1 "$URL" && break
    sleep 0.25
  done
fi

if ! curl -s -o /dev/null --max-time 2 "$URL"; then
  echo "服务启动失败，看日志：/tmp/novel-writer.log" >&2
  exit 1
fi

# 2) 用独立 profile，避免和日常浏览器互相影响
exec "$CHROME" \
  --app="$URL" \
  --ozone-platform=x11 \
  --user-data-dir="$HOME/.local/share/novel-writer/chrome" \
  --disable-extensions \
  --no-first-run \
  --no-default-browser-check \
  --class=NovelWriter \
  --window-size=1240,860
