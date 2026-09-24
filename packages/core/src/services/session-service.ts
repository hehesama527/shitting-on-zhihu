import type { PromptSnapshotMap, ToolTraceStage } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import { closeManualBrowserByPids, launchManualBrowser } from "../utils/chrome-manual-login.js";
import { createManualLoginLock, readManualLoginLock, removeManualLoginLock } from "../utils/manual-login-lock.js";
import { BrowserSkillService } from "./browser-skill-service.js";
import { LlmService } from "./llm-service.js";
import { LayaService } from "./laya-service.js";

type SessionSnapshotInput = {
  url: string;
  title: string;
  visibleTexts: string[];
  buttons?: string[];
  links?: Array<{ text: string; href: string }>;
};

type SessionDetectionResult = {
  session_state?: "active" | "login_required" | "session_expired" | "unknown";
  reason?: string;
  confidence?: "high" | "medium" | "low";
};

type SessionIdentityDetectionResult = {
  identity_status?: "matched" | "mismatched" | "unknown";
  detected_account_name?: string | null;
  reason?: string;
  confidence?: "high" | "medium" | "low";
};

type SessionValidationSnapshot = {
  url: string;
  title: string;
  visibleTexts: string[];
  buttons?: string[];
  links?: Array<{ text: string; href: string }>;
};

type EnsureLoggedInInput = {
  sessionKey: string;
  profileDir: string;
  traceGroupId: string;
  stage?: ToolTraceStage;
  url?: string;
  fallbackUrls?: string[];
  publishJobId?: number | null;
  publishAttemptId?: number | null;
  promptSnapshot?: PromptSnapshotMap | null;
  expectedZhihuUserName?: string | null;
  accountName?: string | null;
};

export class SessionStateError extends Error {
  constructor(
    public readonly sessionState: "login_required" | "session_expired" | "account_identity_mismatch",
    message: string,
    public readonly currentUrl: string | null,
    public readonly snapshot: SessionValidationSnapshot,
    public readonly expectedZhihuUserName: string | null = null,
    public readonly detectedZhihuUserName: string | null = null
  ) {
    super(message);
  }
}

export class SessionService {
  constructor(
    private readonly browserSkillService: BrowserSkillService,
    private readonly llmService?: LlmService,
    private readonly layaService: LayaService = new LayaService()
  ) {}

  async startManualLoginFlow(accountId: number, profileDir: string, returnUrl?: string | null) {
    await createManualLoginLock(accountId);
    await this.browserSkillService.closeSession(`manual-login-${accountId}`);

    const targetUrl = returnUrl ?? `${getAppConfig().zhihuBaseUrl}/`;
    try {
      const launchResult = await launchManualBrowser(profileDir, targetUrl);
      await createManualLoginLock(accountId, {
        browserPids: launchResult.browserPids
      });

      return {
        accountId,
        browserMode: `${getAppConfig().browserChannel}-manual`,
        nextAction: "OPEN_LOGIN_PAGE",
        returnUrl: returnUrl ?? null,
        loginUrl: targetUrl,
        browserPid: launchResult.pid ?? null,
        chromePid: launchResult.pid ?? null,
        executablePath: launchResult.executablePath
      };
    } catch (error) {
      await removeManualLoginLock(accountId);
      throw error;
    }
  }

  async continueAfterManualLogin(accountId: number, publishJobId?: number) {
    await this.closeManualLoginBrowser(accountId);
    await this.browserSkillService.closeSession(`manual-login-${accountId}`);
    if (publishJobId) {
      await this.browserSkillService.closeSession(`publish-account-${accountId}-job-${publishJobId}`);
    }
    await removeManualLoginLock(accountId);

    return {
      accountId,
      publishJobId: publishJobId ?? null,
      nextAction: "RECHECK_SESSION"
    };
  }

  async confirmRecoveredSession(input: {
    accountId: number;
    profileDir: string;
    checkUrl?: string | null;
    returnUrl?: string | null;
    publishJobId?: number | null;
    promptSnapshot?: PromptSnapshotMap | null;
    expectedZhihuUserName?: string | null;
    accountName?: string | null;
  }) {
    const sessionKey = `recovery-check-${input.accountId}`;
    const traceGroupId = `recovery-check-${input.accountId}-${Date.now()}`;
    const recoveryInput: EnsureLoggedInInput = {
      sessionKey,
      profileDir: input.profileDir,
      traceGroupId,
      stage: "login_checking",
      url: input.checkUrl ?? `${getAppConfig().zhihuBaseUrl}/settings/account`,
      fallbackUrls: [`${getAppConfig().zhihuBaseUrl}/`, `${getAppConfig().zhihuBaseUrl}/notifications`],
      publishJobId: input.publishJobId ?? null,
      promptSnapshot: input.promptSnapshot,
      expectedZhihuUserName: input.expectedZhihuUserName ?? null,
      accountName: input.accountName ?? null
    };

    try {
      const recovery = await this.ensureRecoveredSessionWithRetry(input.accountId, recoveryInput);
      await removeManualLoginLock(input.accountId);
      return recovery;
    } finally {
      await this.browserSkillService.closeSession(sessionKey);
    }
  }

  async ensureLoggedIn(input: EnsureLoggedInInput) {
    const traceContext = {
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      traceGroupId: input.traceGroupId,
      publishJobId: input.publishJobId ?? null,
      publishAttemptId: input.publishAttemptId ?? null,
      stage: input.stage ?? "login_checking",
      agentName: "publish_agent"
    } as const;

    const snapshot = await this.openAndSnapshot(traceContext, [
      input.url ?? `${getAppConfig().zhihuBaseUrl}/`,
      ...(input.fallbackUrls ?? [])
    ]);
    const sessionState = normalizeSessionState(await this.detectSessionState(snapshot, input.promptSnapshot), snapshot);

    if (sessionState.session_state === "login_required" || sessionState.session_state === "session_expired") {
      throw new SessionStateError(sessionState.session_state, sessionState.reason, snapshot.url, snapshot);
    }

    const identityCheck = await this.verifyExpectedIdentity({
      traceContext,
      baseSnapshot: snapshot,
      promptSnapshot: input.promptSnapshot,
      expectedZhihuUserName: input.expectedZhihuUserName ?? null,
      accountName: input.accountName ?? null
    });

    if (identityCheck?.identity_status === "mismatched") {
      throw new SessionStateError(
        "account_identity_mismatch",
        buildIdentityMismatchMessage(
          input.expectedZhihuUserName ?? null,
          input.accountName ?? null,
          identityCheck.detected_account_name ?? null,
          identityCheck.reason
        ),
        identityCheck.snapshot.url,
        identityCheck.snapshot,
        input.expectedZhihuUserName ?? null,
        identityCheck.detected_account_name ?? null
      );
    }

    return {
      snapshot: identityCheck?.snapshot ?? snapshot,
      sessionState,
      identityCheck: identityCheck
        ? {
            identityStatus: identityCheck.identity_status,
            detectedAccountName: identityCheck.detected_account_name ?? null,
            reason: identityCheck.reason
          }
        : null
    };
  }

  private async ensureRecoveredSessionWithRetry(accountId: number, input: EnsureLoggedInInput) {
    try {
      return await this.ensureLoggedIn(input);
    } catch (error) {
      if (!isBrowserProfileConflictError(error)) {
        throw error;
      }

      await this.closeManualLoginBrowser(accountId);
      await wait(1_500);
      return this.ensureLoggedIn(input);
    }
  }

  async detectSessionState(
    input: SessionSnapshotInput,
    promptSnapshot?: PromptSnapshotMap | null
  ): Promise<Required<SessionDetectionResult>> {
    const heuristicResult = detectSessionStateHeuristically(input);
    if (heuristicResult) {
      return heuristicResult;
    }

    // 优先尝试本地 Laya 决策加速 (25ms)
    try {
      const layaResult = await this.layaService.detectSessionState(input);
      if (layaResult && layaResult.session_state !== "unknown") {
        return {
          session_state: layaResult.session_state,
          reason: layaResult.reason,
          confidence: layaResult.confidence
        };
      }
    } catch {
      // 异常自动平滑降级至下方的 LLM 兜底
    }

    const fallback: Required<SessionDetectionResult> = {
      session_state: "unknown",
      reason: "没有可用的登录态判断结果，改用页面兜底规则。",
      confidence: "low"
    };

    if (!this.llmService) {
      return fallback;
    }

    const publishPrompt = await this.llmService.resolvePrompt("publish_agent", {
      promptSnapshot
    });

    const result = await withTimeout(
      this.llmService.runJsonWithSystemPrompt<SessionDetectionResult>(
        `${publishPrompt}

补充说明 (v3.0 anti-detection enhanced):
你现在执行的是 Publish Agent 的“登录态判断任务”。

**反检测提醒 (Phase 3)**：系统已强化浏览器指纹 (canvas/WebGL/UA spoof) 和人类行为 (自然鼠标、随机delay、pseudo browse)。在判断时如果看到异常快速操作或机械模式提示，请标记为潜在session_expired或unknown，并建议人工检查。

任务目标：
根据当前知乎页面快照，判断这个账号是否处于可继续执行的已登录状态。

判断规则：
1. 如果页面明显要求登录、注册、手机号验证码登录、密码登录，输出 login_required。
2. 如果页面出现安全验证、异常验证、滑块、身份校验、挑战页、风控提示，输出 session_expired。
3. 如果页面已经能正常看到知乎内容，或者能看到“写回答”“查看我的回答”“编辑回答”等回答相关入口，通常可判为 active。
4. 如果证据不足，输出 unknown，不要硬判。
5. 只输出 JSON，不要解释，不要 Markdown。

输出格式：
{
  "session_state": "active | login_required | session_expired | unknown",
  "reason": "一句话说明原因",
  "confidence": "high | medium | low"
}`,
        input,
        fallback
      ),
      6_000,
      {
        session_state: "unknown",
        reason: "登录态判断超时，改用页面兜底规则。",
        confidence: "low"
      }
    );

    return {
      session_state:
        result.session_state === "active" || result.session_state === "login_required" || result.session_state === "session_expired"
          ? result.session_state
          : "unknown",
      reason: typeof result.reason === "string" && result.reason.trim() ? result.reason : fallback.reason,
      confidence: result.confidence === "high" || result.confidence === "medium" ? result.confidence : "low"
    };
  }

  async detectAccountIdentity(
    input: SessionSnapshotInput,
    expectedZhihuUserName: string,
    promptSnapshot?: PromptSnapshotMap | null
  ): Promise<Required<SessionIdentityDetectionResult>> {
    const expectedName = expectedZhihuUserName.trim();
    const fallback: Required<SessionIdentityDetectionResult> = {
      identity_status: "unknown",
      detected_account_name: null,
      reason: "当前页面没有足够证据判断已登录知乎身份是否与目标账号一致。",
      confidence: "low"
    };

    if (!expectedName || !this.llmService) {
      return fallback;
    }

    const publishPrompt = await this.llmService.resolvePrompt("publish_agent", {
      promptSnapshot
    });

    const result = await withTimeout(
      this.llmService.runJsonWithSystemPrompt<SessionIdentityDetectionResult>(
        `${publishPrompt}

补充说明：
你现在执行的是 Publish Agent 的“知乎账号身份核对任务”。

任务目标：
根据当前知乎页面快照，判断当前已登录的知乎身份，是否与目标账号一致。

目标知乎账号显示名：
${expectedName}

判断规则：
1. 只判断“当前已登录账号本人”的身份，不要把问题作者、回答作者、推荐流里的其他用户名误判成当前登录账号。
2. 如果页面明确展示了当前登录账号的昵称、个人主页标题、账号设置页身份信息，并且与目标账号一致，输出 matched。
3. 如果页面明确展示了另一个账号的昵称、个人主页标题、账号设置页身份信息，且与目标账号不一致，输出 mismatched，并尽量填写 detected_account_name。
4. 如果证据不足，输出 unknown，不要猜。
5. 只输出 JSON，不要解释，不要 Markdown。

输出格式：
{
  "identity_status": "matched | mismatched | unknown",
  "detected_account_name": "当前页面里识别到的账号名，没有就填 null",
  "reason": "一句话说明原因",
  "confidence": "high | medium | low"
}`,
        input,
        fallback
      ),
      6_000,
      {
        identity_status: "unknown",
        detected_account_name: null,
        reason: "账号身份核对超时，暂时无法确认当前 Profile 的知乎身份。",
        confidence: "low"
      }
    );

    return {
      identity_status:
        result.identity_status === "matched" || result.identity_status === "mismatched" ? result.identity_status : "unknown",
      detected_account_name:
        typeof result.detected_account_name === "string" && result.detected_account_name.trim()
          ? result.detected_account_name.trim()
          : null,
      reason: typeof result.reason === "string" && result.reason.trim() ? result.reason : fallback.reason,
      confidence: result.confidence === "high" || result.confidence === "medium" ? result.confidence : "low"
    };
  }

  private async closeManualLoginBrowser(accountId: number) {
    const lock = await readManualLoginLock(accountId);
    if (!lock?.browserPids?.length) {
      return;
    }

    await closeManualBrowserByPids(lock.browserPids);
    await wait(800);
  }

  private async openAndSnapshot(
    traceContext: {
      sessionKey: string;
      profileDir: string;
      traceGroupId: string;
      publishJobId?: number | null;
      publishAttemptId?: number | null;
      stage: ToolTraceStage;
      agentName: "publish_agent";
    },
    urls: Array<string | null | undefined>
  ) {
    const candidates = Array.from(new Set(urls.map((url) => (typeof url === "string" ? url.trim() : "")).filter(Boolean)));
    const fallbackUrl = `${getAppConfig().zhihuBaseUrl}/`;
    const attempts = candidates.length ? candidates : [fallbackUrl];
    let lastError: unknown = null;

    for (const url of attempts) {
      try {
        await this.browserSkillService.open(traceContext, {
          url
        });
        await this.browserSkillService.wait(traceContext, { ms: 1_200 });
        return await this.browserSkillService.snapshot(traceContext);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    await this.browserSkillService.open(traceContext, {
      url: fallbackUrl
    });
    await this.browserSkillService.wait(traceContext, { ms: 1_200 });
    return this.browserSkillService.snapshot(traceContext);
  }

  private async verifyExpectedIdentity(input: {
    traceContext: {
      sessionKey: string;
      profileDir: string;
      traceGroupId: string;
      publishJobId?: number | null;
      publishAttemptId?: number | null;
      stage: ToolTraceStage;
      agentName: "publish_agent";
    };
    baseSnapshot: SessionValidationSnapshot;
    promptSnapshot?: PromptSnapshotMap | null;
    expectedZhihuUserName?: string | null;
    accountName?: string | null;
  }) {
    const expectedZhihuUserName = input.expectedZhihuUserName?.trim();
    if (!expectedZhihuUserName) {
      return null;
    }

    let snapshot = input.baseSnapshot;
    try {
      snapshot = await this.openAndSnapshot(input.traceContext, [
        `${getAppConfig().zhihuBaseUrl}/settings/account`,
        input.baseSnapshot.url,
        `${getAppConfig().zhihuBaseUrl}/`
      ]);
    } catch {
      snapshot = input.baseSnapshot;
    }

    const sessionState = normalizeSessionState(await this.detectSessionState(snapshot, input.promptSnapshot), snapshot);
    if (sessionState.session_state === "login_required" || sessionState.session_state === "session_expired") {
      throw new SessionStateError(
        sessionState.session_state,
        sessionState.reason,
        snapshot.url,
        snapshot,
        expectedZhihuUserName,
        null
      );
    }

    const identityResult = await this.detectAccountIdentity(snapshot, expectedZhihuUserName, input.promptSnapshot);
    return {
      ...identityResult,
      snapshot,
      accountName: input.accountName ?? null
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSessionState(
  detected: SessionDetectionResult,
  snapshot: SessionValidationSnapshot
) {
  const heuristic = detectSessionStateHeuristically(snapshot);
  const hasLoginHint = heuristic?.session_state === "login_required";
  const hasChallengeHint = heuristic?.session_state === "session_expired";

  if (detected.session_state === "login_required" || detected.session_state === "session_expired") {
    return {
      session_state: detected.session_state,
      reason: detected.reason || "没有检测到可复用的知乎登录状态。",
      confidence: detected.confidence ?? "medium"
    } as const;
  }

  if (hasChallengeHint) {
    return {
      session_state: "session_expired",
      reason: detected.reason || "页面进入验证或风控状态，请先人工恢复登录。",
      confidence: "high"
    } as const;
  }

  if (hasLoginHint) {
    return {
      session_state: "login_required",
      reason: detected.reason || "当前账号尚未登录知乎，请先登录后继续。",
      confidence: "high"
    } as const;
  }

  return {
    session_state: "active",
    reason: detected.reason || "已检测到可继续执行的知乎页面。",
    confidence: detected.confidence ?? "medium"
  } as const;
}

function buildIdentityMismatchMessage(
  expectedZhihuUserName: string | null,
  accountName: string | null,
  detectedAccountName: string | null,
  reason: string
) {
  const expectedLabel = expectedZhihuUserName?.trim() || accountName?.trim() || "当前账号";
  const detectedLabel = detectedAccountName?.trim();

  if (detectedLabel) {
    return `当前 Profile 已登录知乎，但检测到的账号是「${detectedLabel}」，与当前账号绑定的知乎账号「${expectedLabel}」不一致。请切到正确账号重新登录，或重置这个账号的 Profile。${reason ? ` ${reason}` : ""}`.trim();
  }

  return `当前 Profile 已登录知乎，但系统判断它与当前账号绑定的知乎账号「${expectedLabel}」不一致。请重新登录或重置这个账号的 Profile。${reason ? ` ${reason}` : ""}`.trim();
}

function detectSessionStateHeuristically(input: SessionSnapshotInput): Required<SessionDetectionResult> | null {
  const combinedText = [
    input.url,
    input.title,
    ...input.visibleTexts,
    ...(input.buttons ?? []),
    ...(input.links ?? []).flatMap((link) => [link.text, link.href])
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const challengeHints = [
    "安全验证",
    "异常验证",
    "验证身份",
    "请完成验证",
    "滑块验证",
    "拖动滑块",
    "人机验证",
    "访问受限",
    "风险验证",
    "账号存在异常"
  ];
  const loginHints = [
    "登录/注册",
    "注册/登录",
    "立即登录",
    "请先登录",
    "请登录后继续",
    "登录后继续",
    "登录后可继续",
    "登录知乎",
    "验证码登录",
    "手机号登录",
    "密码登录",
    "获取短信验证码"
  ];
  const activeHints = [
    "账号设置",
    "登录方式",
    "绑定手机",
    "绑定邮箱",
    "创作中心",
    "创作者中心",
    "发想法",
    "私信",
    "消息"
  ];
  const isChallengeUrl = /zhihu\.com\/account\/unhuman|captcha|challenge/i.test(input.url);
  const isLoginUrl = /zhihu\.com\/signin|zhihu\.com\/login/i.test(input.url);
  const isKnownLoggedInSurface =
    /zhihu\.com\/settings\//i.test(input.url) ||
    /zhihu\.com\/creator/i.test(input.url) ||
    /zhihu\.com\/notifications/i.test(input.url);

  if (isChallengeUrl || challengeHints.some((text) => combinedText.includes(text))) {
    return {
      session_state: "session_expired",
      reason: "页面进入验证或风控状态，请先人工完成验证后再继续。",
      confidence: "high"
    };
  }

  if (isLoginUrl || loginHints.some((text) => combinedText.includes(text))) {
    return {
      session_state: "login_required",
      reason: "当前账号尚未登录知乎，请先完成登录后再确认恢复。",
      confidence: "high"
    };
  }

  if (isKnownLoggedInSurface || activeHints.some((text) => combinedText.includes(text))) {
    return {
      session_state: "active",
      reason: "页面已显示知乎账号的已登录内容，可继续执行。",
      confidence: "medium"
    };
  }

  return null;
}

function isBrowserProfileConflictError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("profile") &&
      (normalized.includes("occupied") || normalized.includes("占用")) ||
    normalized.includes("launchpersistentcontext") &&
      (normalized.includes("target page, context or browser has been closed") ||
        normalized.includes("user-data-dir") ||
        normalized.includes("user data directory") ||
        normalized.includes("browser logs"))
  );
}
