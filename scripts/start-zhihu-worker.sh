#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

CLAW=/home/userroot/文档/claw
cd "$CLAW"

set -a
# shellcheck disable=SC1091
. ./.env
if [ -f /tmp/.tmp-zhihu-llm-overlay.env ]; then
  # shellcheck disable=SC1091
  . /tmp/.tmp-zhihu-llm-overlay.env
fi
set +a

# 223 上的 Clash 7890 能给浏览器用，但 Node/curl 走这条 HTTP 代理时 TLS 会被掐断。
# 浏览器自己探测 7890。模型请求直连，避免把坏代理注进 GPT 调用。
unset HTTPS_PROXY HTTP_PROXY ALL_PROXY https_proxy http_proxy all_proxy || true
unset PLAYWRIGHT_HEADLESS || true
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-/run/user/1000/gdm/Xauthority}"
export NODE_ENV=production

exec node apps/worker/dist/apps/worker/src/index.js
