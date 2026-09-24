import fs from "node:fs/promises";
import path from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import type { BrowserContext, Page } from "playwright";
import { getXAppConfig, type XAppConfig } from "../config.js";
import type { XAccount } from "../types.js";
import { getStealthInitScripts, getProfileUserAgent, validateFingerprintConsistency } from "../../../core/src/utils/stealth-inject.js";
import { logBrowserAudit } from "../../../core/src/utils/browser-audit.js";

/**
 * Gaussian random using Box-Muller transform
 */
function gaussianRandom(mean: number = 60, stdDev: number = 25): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mean + num * stdDev;
}

/**
 * Gaussian delay with configurable mean, stdDev and minimum
 */
function gaussianDelayMs(mean: number = 60, stdDev: number = 42, minMs: number = 8): number {
  return Math.max(minMs, Math.floor(gaussianRandom(mean, stdDev)));
}

/**
 * Human wait with gaussian delay
 */
async function humanWait(baseMs: number = 50, antiDetectionEnabled: boolean = false): Promise<void> {
  if (!antiDetectionEnabled) {
    await new Promise(r => setTimeout(r, 10));
    return;
  }
  const delay = Math.max(15, Math.floor(gaussianRandom(baseMs, baseMs * 0.6)));
  await new Promise(r => setTimeout(r, delay));
}

/**
 * Enhanced human move with dynamic bezier curve
 * - Dynamic step count based on distance (farther = more steps for smoother movement)
 * - Dynamic bezier segments (3-8 based on distance)
 * - Speed curve: accelerate at start, decelerate at end
 * - Natural micro-jitter throughout movement
 */
async function humanMove(
  page: Page,
  targetX: number,
  targetY: number,
  antiDetectionEnabled: boolean = false,
  options?: { intensity?: 'low' | 'medium' | 'high'; startX?: number; startY?: number }
): Promise<void> {
  if (!antiDetectionEnabled) {
    await page.mouse.move(targetX, targetY);
    return;
  }

  const intensity = options?.intensity ?? 'high';
  const startX = options?.startX ?? 960;
  const startY = options?.startY ?? 540;

  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.hypot(dx, dy);

  // Dynamic step count: farther = more steps (smoother), closer = fewer steps
  const minSteps = intensity === 'high' ? 12 : intensity === 'medium' ? 8 : 5;
  const maxSteps = intensity === 'high' ? 30 : intensity === 'medium' ? 20 : 12;
  const steps = Math.max(minSteps, Math.min(maxSteps, Math.floor(distance / 18)));

  // Dynamic bezier segments based on distance
  const segments = distance > 600 ? 7 : distance > 300 ? 5 : distance > 150 ? 3 : 2;

  let currentX = startX;
  let currentY = startY;

  for (let i = 0; i < steps; i++) {
    const progress = (i + 1) / steps;

    // Speed curve: ease-in-out (natural human movement: slow start, fast middle, slow end)
    const easedProgress = progress < 0.15
      ? progress / 0.15 * 0.15  // 0-15%: acceleration phase
      : progress < 0.85
        ? 0.15 + (progress - 0.15) / 0.7 * 0.75  // 15-85%: cruising
        : 0.9 + (progress - 0.85) / 0.15 * 0.1;  // 85-100%: deceleration

    const targetProgressX = startX + dx * easedProgress;
    const targetProgressY = startY + dy * easedProgress;

    // Bezier control points - scale deviation by distance and intensity
    const stdDev = intensity === 'high' ? 28 : intensity === 'medium' ? 20 : 12;
    const maxOffset = distance * 0.25;
    const cp1x = currentX + Math.min(maxOffset, gaussianRandom((targetProgressX - currentX) * 0.5, stdDev));
    const cp1y = currentY + Math.min(maxOffset, gaussianRandom((targetProgressY - currentY) * 0.3, stdDev * 0.8));
    const cp2x = targetProgressX - Math.min(maxOffset, gaussianRandom((targetProgressX - currentX) * 0.3, stdDev));
    const cp2y = targetProgressY - Math.min(maxOffset, gaussianRandom((targetProgressY - currentY) * 0.5, stdDev * 0.8));

    // Multi-segment bezier interpolation
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const x = Math.pow(1 - t, 3) * currentX +
                3 * Math.pow(1 - t, 2) * t * cp1x +
                3 * (1 - t) * Math.pow(t, 2) * cp2x +
                Math.pow(t, 3) * targetProgressX;
      const y = Math.pow(1 - t, 3) * currentY +
                3 * Math.pow(1 - t, 2) * t * cp1y +
                3 * (1 - t) * Math.pow(t, 2) * cp2y +
                Math.pow(t, 3) * targetProgressY;

      await page.mouse.move(Math.round(x), Math.round(y));

      // Variable speed: faster in middle, slower at ends
      const speedFactor = Math.sin(Math.PI * t); // 0 at ends, 1 in middle
      const baseDelay = intensity === 'high' ? 6 : intensity === 'medium' ? 10 : 15;
      const stepDelay = baseDelay + speedFactor * 8;
      await humanWait(stepDelay, true);
    }

    currentX = targetProgressX;
    currentY = targetProgressY;
  }

  // Final micro-adjustment with tiny jitter
  await page.mouse.move(
    targetX + gaussianRandom(0, 1.2),
    targetY + gaussianRandom(0, 1.2)
  );
  await humanWait(12, true);
}

/**
 * Split text into natural word groups for human-like typing
 */
function splitTextForHumanTyping(text: string): string[] {
  // Split by sentences first (。！？.!?), then by words/phrases
  const sentences = text.split(/([。！？.!?]+)/);
  const chunks: string[] = [];
  
  for (let i = 0; i < sentences.length; i += 2) {
    const sentence = sentences[i];
    const punctuation = sentences[i + 1] || '';
    
    if (!sentence.trim()) continue;
    
    // Split long sentences into smaller chunks by commas, spaces, or natural breaks
    const parts = sentence.split(/([,，、;；]+)/);
    for (let j = 0; j < parts.length; j += 2) {
      const part = parts[j];
      const separator = parts[j + 1] || '';
      if (part.trim()) {
        chunks.push(part + separator);
      }
    }
    if (punctuation) {
      chunks.push(punctuation);
    }
  }
  
  return chunks.filter(c => c.length > 0);
}

type XBrowserSession = {
  context: BrowserContext;
  page: Page;
  profileDir: string;
  proxyUrl: string | null;
  headless: boolean;
  lockPath: string;
  lockOwner: string;
};

type XBrowserSessionOptions = {
  headless?: boolean;
};

type XLoginResult = {
  success: boolean;
  errorMessage?: string;
  sessionToken?: string;
};

export class XBrowserRuntime {
  private readonly sessions = new Map<string, XBrowserSession>();

  constructor(private readonly config: XAppConfig = getXAppConfig()) {}

  async verifyLogin(
    account: XAccount,
    options?: { profileDir?: string; proxyUrl?: string | null }
  ): Promise<XLoginResult> {
    const profileDir = options?.profileDir || account.profileDir;
    const proxyUrl = options?.proxyUrl ?? account.proxyUrl;
    const sessionKey = `verify-${account.id}`;

    try {
      const result = await this.withSession(sessionKey, profileDir, proxyUrl, async (page) => {
        await page.goto("https://twitter.com/home", {
          waitUntil: "domcontentloaded",
          timeout: 30_000
        });
        await page.waitForTimeout(3_000);

        const isLoggedIn = (await page.$('div[data-testid="SideNav_AccountSwitcher_Button"]')) !== null;
        if (!isLoggedIn) {
          const loginButton = await page.$('a[href="/i/flow/login"]');
          if (loginButton) {
            return {
              success: false,
              errorMessage: "Twitter account is not logged in. Complete the login flow first."
            };
          }
        }

        const errorSelectors = ['[data-testid="error-description"]', ".ErrorText", '[role="alert"]'];
        for (const selector of errorSelectors) {
          const errorElement = await page.$(selector);
          if (errorElement) {
            const errorText = await errorElement.textContent();
            return {
              success: false,
              errorMessage: `Twitter returned an error: ${errorText?.trim() || "Unknown error"}`
            };
          }
        }

        return {
          success: true,
          sessionToken: await this.extractSessionToken(page)
        };
      });

      return result;
    } catch (error) {
      return {
        success: false,
        errorMessage: error instanceof Error ? error.message : "Login verification failed"
      };
    } finally {
      await this.closeSession(sessionKey).catch(() => undefined);
    }
  }

  private async extractSessionToken(page: Page): Promise<string | undefined> {
    try {
      const cookies = await page.context().cookies();
      const authToken = cookies.find((cookie) => cookie.name === "auth_token");
      return authToken?.value;
    } catch {
      return undefined;
    }
  }

  async withSession<T>(
    sessionKey: string,
    profileDir: string,
    proxyUrl: string | null | undefined,
    operation: (page: Page, context: BrowserContext) => Promise<T>,
    options?: XBrowserSessionOptions
  ) {
    const session = await this.ensureSession(sessionKey, profileDir, proxyUrl, options);
    return operation(session.page, session.context);
  }

  async closeSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionKey);

    try {
      await session.context.close().catch(() => undefined);
    } finally {
      await releaseProfileLock(session.lockPath, session.lockOwner).catch(() => undefined);
    }
  }

  private async ensureSession(
    sessionKey: string,
    profileDir: string,
    proxyUrl: string | null | undefined,
    options?: XBrowserSessionOptions
  ) {
    const resolvedProfileDir = path.isAbsolute(profileDir)
      ? profileDir
      : path.join(this.config.browserProfileRoot, profileDir);
    const resolvedProxyUrl = normalizeOptionalValue(proxyUrl) ?? this.config.browserProxyUrl ?? 'http://127.0.0.1:7890';
    const resolvedHeadless = options?.headless ?? this.config.browserHeadless;

    const existing = this.sessions.get(sessionKey);
    if (
      existing &&
      !existing.page.isClosed() &&
      existing.profileDir === resolvedProfileDir &&
      existing.proxyUrl === resolvedProxyUrl &&
      existing.headless === resolvedHeadless
    ) {
      return existing;
    }

    if (existing) {
      await this.closeSession(sessionKey);
    }

    await fs.mkdir(resolvedProfileDir, { recursive: true });

    const lockOwner = `${process.pid}:${sessionKey}`;
    const lockPath = path.join(resolvedProfileDir, ".x-browser.lock");
    await acquireProfileLock(lockPath, lockOwner);

    try {
      const stealthArgs = this.config.antiDetectionV3Enabled ? [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
        "--disable-blink-features=SiteIsolationTrials,Translate",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-features=AudioServiceOutOfProcess",
        "--lang=en-US",
        "--accept-lang=en-US,en",
        "--window-size=1920,1080",
        "--force-device-scale-factor=1",
        "--disable-gpu",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ] : ["--start-maximized", "--disable-blink-features=AutomationControlled"];

      const launchOptions: any = {
        userDataDir: resolvedProfileDir,
        headless: resolvedHeadless,
        viewport: null,
        proxy: resolvedProxyUrl ? resolvedProxyUrl : undefined,
        args: stealthArgs,
      };

      // Use per-profile UA for fingerprint consistency
      if (this.config.antiDetectionV3Enabled) {
        launchOptions.userAgent = getProfileUserAgent(resolvedProfileDir);
        launchOptions.locale = "en-US";
        launchOptions.timezoneId = "America/New_York";
      }

      const context = (await launchPersistentContext(launchOptions)) as unknown as BrowserContext;

      const page = context.pages()[0] ?? (await context.newPage());

      // Inject stealth scripts with profileDir as deterministic seed
      if (this.config.antiDetectionV3Enabled) {
        const initScripts = getStealthInitScripts(resolvedProfileDir);
        for (const script of initScripts) {
          await context.addInitScript(script);
        }
      }

      const session: XBrowserSession = {
        context,
        page,
        profileDir: resolvedProfileDir,
        proxyUrl: resolvedProxyUrl,
        headless: resolvedHeadless,
        lockPath,
        lockOwner
      };
      this.sessions.set(sessionKey, session);

      // Log session creation for audit trail
      console.log(`[X-Browser] Session created: ${sessionKey}, profile: ${resolvedProfileDir.slice(-40)}`);

      return session;
    } catch (error) {
      await releaseProfileLock(lockPath, lockOwner).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Enhanced human-like click with dynamic bezier mouse movement
   */
  async humanClick(page: Page, selector: string, options?: { offset?: { x: number; y: number } }): Promise<void> {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();

    const box = await locator.boundingBox();
    if (box) {
      const centerX = box.x + box.width / 2 + (options?.offset?.x ?? (Math.random() * 6 - 3));
      const centerY = box.y + box.height / 2 + (options?.offset?.y ?? (Math.random() * 6 - 3));
      await humanMove(page, centerX, centerY, this.config.antiDetectionV3Enabled);
    }

    await locator.click();

    // Post-click micro-movement (natural behavior)
    if (this.config.antiDetectionV3Enabled) {
      await humanWait(50 + Math.random() * 100, true);
      const jitterX = Math.random() * 20 - 10;
      const jitterY = Math.random() * 20 - 10;
      const pointerPosition = await page.evaluate(() => ({
        x: (window as { mouseX?: number }).mouseX ?? 500,
        y: (window as { mouseY?: number }).mouseY ?? 500
      }));
      await page.mouse.move(
        pointerPosition.x + jitterX,
        pointerPosition.y + jitterY
      );
    }
  }

  /**
   * Enhanced human-like type with smart word-group input
   * - Splits text by natural word groups (sentences, commas)
   * - Types word groups with variable speed
   * - Occasional "thinking pauses" (5% probability, 200-600ms)
   * - Occasional backspace/retyping (3% probability, simulates typos)
   */
  async humanType(page: Page, selector: string, text: string): Promise<void> {
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded();

    // Focus with human movement
    const box = await locator.boundingBox();
    if (box) {
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      await humanMove(page, centerX, centerY, this.config.antiDetectionV3Enabled);
    }

    await locator.click();
    await humanWait(150 + Math.random() * 250, this.config.antiDetectionV3Enabled);

    if (!this.config.antiDetectionV3Enabled) {
      await page.keyboard.type(text, { delay: 40 });
      await humanWait(200, false);
      return;
    }

    // Smart word-group typing
    const chunks = splitTextForHumanTyping(text);
    
    for (const chunk of chunks) {
      // 5% chance of "thinking pause" between chunks
      if (chunk.length > 2 && Math.random() < 0.05) {
        await humanWait(200 + Math.random() * 400, true);
      }
      
      // 3% chance of typo + backspace (only for chunks > 3 chars)
      if (chunk.length > 3 && Math.random() < 0.03) {
        const typoPoint = Math.floor(chunk.length * 0.6) + Math.floor(Math.random() * 2);
        await page.keyboard.type(chunk.slice(0, typoPoint), { delay: gaussianDelayMs(25, 15, 5) });
        await humanWait(150 + Math.random() * 200, true);
        // Backspace 1-2 chars
        const backspaceCount = Math.min(1 + Math.floor(Math.random() * 2), typoPoint);
        for (let i = 0; i < backspaceCount; i++) {
          await page.keyboard.press('Backspace');
          await humanWait(80 + Math.random() * 120, true);
        }
        // Retype the rest
        await page.keyboard.type(chunk.slice(typoPoint - backspaceCount), { delay: gaussianDelayMs(30, 18, 5) });
      } else {
        // Normal typing with variable delay
        const charDelay = gaussianDelayMs(35, 20, 8);
        await page.keyboard.type(chunk, { delay: charDelay });
      }
      
      // Inter-chunk pause (longer for longer chunks)
      if (chunk.length > 2) {
        await humanWait(150 + Math.random() * 250, true);
      }
    }

    // Post-type natural pause
    await humanWait(300 + Math.random() * 400, true);
  }

  /**
   * Enhanced pseudo-browse behavior
   * - Context-related scrolling with reading pauses
   * - Occasional sidebar/related content viewing (20% chance)
   * - Reduced frequency: more natural browsing rhythm
   */
  async pseudoBrowse(page: Page): Promise<void> {
    if (!this.config.antiDetectionV3Enabled) {
      await page.waitForTimeout(500);
      return;
    }

    // Natural scrolling with reading pauses
    const scrollCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < scrollCount; i++) {
      const scrollY = 80 + Math.random() * 180; // Positive scroll (reading down)
      await page.evaluate((y: number) => window.scrollBy(0, y), scrollY);
      // Reading pause proportional to scroll amount
      await humanWait(400 + scrollY * 3 + Math.random() * 300, true);
    }

    // 20% chance: look at sidebar/recommendations
    if (Math.random() < 0.2) {
      const sidebarElements = await page.locator('aside, [role="complementary"], nav').all();
      if (sidebarElements.length > 0) {
        const randomSidebar = sidebarElements[Math.floor(Math.random() * sidebarElements.length)];
        const box = await randomSidebar.boundingBox().catch(() => null);
        if (box) {
          await humanMove(page, box.x + box.width / 2, box.y + box.height / 3, true);
          await humanWait(500 + Math.random() * 800, true);
        }
      }
    }

    // Random hover on interactive elements (more targeted)
    const hoverElements = await page.locator('a[href], button, [role="button"]').all();
    if (hoverElements.length > 0) {
      // Pick from first half (more likely to hover visible/important elements)
      const pickFrom = Math.max(1, Math.floor(hoverElements.length * 0.4));
      const randomElement = hoverElements[Math.floor(Math.random() * pickFrom)];
      const hoverBox = await randomElement.boundingBox().catch(() => null);
      if (hoverBox) {
        await humanMove(page, hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2, true);
        await humanWait(200 + Math.random() * 300, true);
      }
    }

    // Final reading pause
    await humanWait(600 + Math.random() * 1000, true);
  }

  /**
   * Validate fingerprint consistency for the current profile.
   * Call after browser launch to ensure stealth injection is working correctly.
   */
  async validateFingerprint(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const validation = validateFingerprintConsistency(this.sessions.values().next().value?.profileDir || 'unknown');
    
    if (!validation.valid) {
      issues.push(`Fingerprint check failed: ${validation.message}`);
      return { valid: false, issues };
    }
    
    // Additional runtime checks
    const session = this.sessions.values().next().value;
    if (session) {
      try {
        const page = session.page;
        const actualUA = await page.evaluate(() => navigator.userAgent);
        if (actualUA !== validation.ua && validation.ua !== 'unknown') {
          // UA mismatch - could be browser extension or other modification
          issues.push(`UA may differ from expected (profile: ${validation.ua.slice(0,30)}..., actual: ${actualUA.slice(0,30)}...)`);
        }
        const actualHW = await page.evaluate(() => navigator.hardwareConcurrency);
        if (actualHW !== validation.hardwareConcurrency) {
          issues.push(`hardwareConcurrency mismatch (expected: ${validation.hardwareConcurrency}, actual: ${actualHW})`);
        }
      } catch {
        // Page might be closed
      }
    }
    
    return { valid: issues.length === 0, issues };
  }
}

async function acquireProfileLock(lockPath: string, lockOwner: string) {
  const timeoutMs = 30_000;
  const intervalMs = 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({
          owner: lockOwner,
          pid: process.pid,
          createdAt: new Date().toISOString()
        })
      );
      await handle.close();
      return;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const reclaimed = await tryReclaimStaleLock(lockPath, lockOwner);
      if (reclaimed) {
        continue;
      }

      await wait(intervalMs);
    }
  }

  throw new Error("X browser profile is currently in use.");
}

async function releaseProfileLock(lockPath: string, lockOwner: string) {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(content) as { owner?: string };
    if (parsed.owner && parsed.owner !== lockOwner) {
      return;
    }
  } catch {
    return;
  }

  await fs.rm(lockPath, { force: true });
}

async function tryReclaimStaleLock(lockPath: string, lockOwner: string) {
  try {
    const content = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(content) as { owner?: string; pid?: number; createdAt?: string };

    if (parsed.owner === lockOwner) {
      await fs.rm(lockPath, { force: true });
      return true;
    }

    const createdAt = parsed.createdAt ? new Date(parsed.createdAt).getTime() : 0;
    const isExpired = !createdAt || Date.now() - createdAt > 10 * 60 * 1000;
    const pidAlive = typeof parsed.pid === "number" ? isProcessAlive(parsed.pid) : false;

    if (!pidAlive || isExpired) {
      await fs.rm(lockPath, { force: true });
      return true;
    }
  } catch {
    await fs.rm(lockPath, { force: true });
    return true;
  }

  return false;
}

function isAlreadyExistsError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST");
}

function isProcessAlive(pid: number) {
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

function normalizeOptionalValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
