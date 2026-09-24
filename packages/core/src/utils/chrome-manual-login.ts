import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { getAppConfig } from "../config/env.js";
import { resolveBrowserExecutable, resolveBrowserProfileDir } from "./browser.js";

type LaunchManualChromeResult = {
  executablePath: string;
  pid: number | undefined;
  browserPids: number[];
  targetUrl: string;
  profileDir: string;
};

export async function launchManualBrowser(profileDir: string, targetUrl: string): Promise<LaunchManualChromeResult> {
  const browserChannel = getAppConfig().browserChannel;
  const resolvedProfileDir = resolveBrowserProfileDir(profileDir, browserChannel);
  await fs.mkdir(resolvedProfileDir, { recursive: true });

  const executablePath = resolveBrowserExecutable(browserChannel);
  const launchArgs = [
    `--user-data-dir=${resolvedProfileDir}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    // Align manual-login Edge with Playwright's persistent context on Linux so
    // both processes read and write the same cookie/keyring format.
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-sandbox",
    targetUrl
  ];

  const child = spawn(executablePath, launchArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });

  child.unref();

  return {
    executablePath,
    pid: child.pid,
    browserPids: [child.pid].map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0),
    targetUrl,
    profileDir: resolvedProfileDir
  };
}

export async function launchManualChrome(profileDir: string, targetUrl: string): Promise<LaunchManualChromeResult> {
  return launchManualBrowser(profileDir, targetUrl);
}

export async function closeManualBrowserByPids(pids: Array<number | null | undefined>) {
  const normalizedPids = [...new Set(pids.map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0))];

  for (const pid of normalizedPids) {
    await killProcessTree(pid);
  }
}

export async function closeManualBrowserByProfileDir(profileDir: string) {
  const browserChannel = getAppConfig().browserChannel;
  const resolvedProfileDir = resolveBrowserProfileDir(profileDir, browserChannel);

  if (process.platform !== "win32") {
    return;
  }

  const escapedProfileDir = resolvedProfileDir.replace(/'/g, "''");
  const browserName = browserChannel === "chrome" ? "chrome.exe" : "msedge.exe";
  const script = `
$profileDir = '${escapedProfileDir}'
$processes = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq '${browserName}' -and
    $_.CommandLine -and
    $_.CommandLine -like "*$profileDir*"
  }
foreach ($process in $processes) {
  try {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
  } catch {
  }
}
`;

  await new Promise<void>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", script], {
      detached: false,
      stdio: "ignore",
      windowsHide: true
    });

    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });

  await wait(1200);
}

export async function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: false,
        stdio: "ignore",
        windowsHide: true
      });

      child.on("error", () => resolve());
      child.on("close", () => resolve());
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await wait(800);
  if (!isPidAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    return;
  }
}

export async function killBrowsersByUserDataDir(profileDir: string) {
  if (!profileDir) {
    return;
  }

  if (process.platform === "win32") {
    await closeManualBrowserByProfileDir(profileDir);
    return;
  }

  await new Promise<void>((resolve) => {
    const child = spawn("pkill", ["-9", "-f", "--", profileDir], {
      detached: false,
      stdio: "ignore"
    });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
