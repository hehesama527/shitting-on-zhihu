const path = require("node:path");

const rootDir = __dirname;
const logDir = path.join(rootDir, ".runlogs");

function createApp(name, args) {
  return {
    name,
    cwd: rootDir,
    script: "npm",
    args,
    interpreter: "none",
    exec_mode: "fork",
    autorestart: true,
    restart_delay: 3000,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "production"
    },
    out_file: path.join(logDir, `${name}.out.log`),
    error_file: path.join(logDir, `${name}.err.log`),
    merge_logs: true,
    time: true
  };
}

function createScriptApp(name, scriptRelativePath) {
  return {
    name,
    cwd: rootDir,
    script: path.join(rootDir, scriptRelativePath),
    interpreter: "bash",
    exec_mode: "fork",
    autorestart: true,
    restart_delay: 3000,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "production"
    },
    out_file: path.join(logDir, `${name}.out.log`),
    error_file: path.join(logDir, `${name}.err.log`),
    merge_logs: true,
    time: true
  };
}

module.exports = {
  apps: [
    createScriptApp("laya-service", "scripts/start-laya-service.sh"),
    createApp("zhihu-api", "run start -w @zhihu-mvp/api"),
    createApp("control-api", "run start -w @zhihu-mvp/control-api"),
    createApp("hotspot-api", "run start -w @zhihu-mvp/hotspot-api"),
    createApp("x-main-api", "run start -w @zhihu-mvp/x-api"),
    createApp("x-main-worker", "run start -w @zhihu-mvp/x-worker"),
    createApp("x-traditional-api", "run start -w @zhihu-mvp/x-traditional-api"),
    createApp("x-traditional-worker", "run start -w @zhihu-mvp/x-traditional-worker"),
    createApp("zhihu-worker", "run start -w @zhihu-mvp/worker"),
    createApp("zhihu-ops-agent", "run start -w @zhihu-mvp/ops-agent"),
    createApp("zhihu-web", "run start -w @zhihu-mvp/web -- --hostname 127.0.0.1 --port 3000")
  ]
};
