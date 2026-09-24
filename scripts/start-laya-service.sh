#!/usr/bin/env bash
set -euo pipefail

export HF_ENDPOINT="https://hf-mirror.com"
export PYTHONUNBUFFERED="1"

CLAW=/home/userroot/文档/claw
cd "$CLAW/laya"

exec "$CLAW/laya/.venv/bin/python3" -m uvicorn server:app --host 127.0.0.1 --port 8105
