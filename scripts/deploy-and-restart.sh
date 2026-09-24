#!/bin/bash
set -e
export PATH=/home/userroot/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin:$PATH
cd /home/userroot/文档/claw

echo "=== 1. Clean Zombie Browsers ==="
pkill -9 -f "chrome" || true
pkill -9 -f "msedge" || true
pkill -9 -f "playwright" || true
sleep 1

echo "=== 2. Restart Laya Service ==="
pm2 restart laya-service
sleep 3

echo "=== 3. Restart Zhihu Worker ==="
pm2 restart zhihu-worker --update-env
sleep 2

echo "=== 4. Test Laya on Question Snapshot with '编辑回答' ==="
node scripts/check-450-trace.mjs

echo "=== 5. Reset Target Jobs (450, 459, 466) ==="
node scripts/reset-target-jobs.mjs

echo "=== Deployment Complete ==="
