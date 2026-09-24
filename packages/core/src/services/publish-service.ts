import type { FailureType, PromptSnapshotMap, PublishStepAction, PublishStepPlan } from "@zhihu-mvp/shared";
import { normalizeZhihuQuestionUrl } from "../utils/zhihu-url.js";
import { LlmService } from "./llm-service.js";
import { BrowserSkillService, type BrowserSkillContext, type PageSnapshot } from "./browser-skill-service.js";
import { SessionService } from "./session-service.js";
import { LayaService } from "./laya-service.js";

const EDITOR_SELECTORS = [
  "[role='textbox']",
  ".public-DraftEditor-content",
  ".DraftEditor-root div[contenteditable='true']",
  "[contenteditable='true']"
];

const SUBMIT_TEXT_CANDIDATES = ["发布回答", "提交回答", "更新回答", "保存修改", "发布修改"];
const DIRECT_SUBMIT_SELECTORS = [
  "button:has-text('发布回答')",
  "button:has-text('提交回答')",
  "button:has-text('更新回答')",
  "button:has-text('保存修改')",
  "button:has-text('发布修改')",
  ".PublishPanel button:has-text('发布')",
  ".PublishPanel-btnGroup button",
  ".AnswerForm button:has-text('发布回答')",
  ".AnswerForm button:has-text('提交回答')",
  ".AnswerForm button:has-text('更新回答')",
  ".AnswerForm button:has-text('保存修改')",
  ".AnswerForm button:has-text('发布修改')",
  ".AnswerForm [role='button']:has-text('发布回答')",
  ".AnswerForm [role='button']:has-text('提交回答')",
  ".AnswerForm [role='button']:has-text('更新回答')",
  ".AnswerForm [role='button']:has-text('保存修改')",
  ".AnswerForm [role='button']:has-text('发布修改')",
  "[class*='AnswerForm'] button:has-text('发布回答')",
  "[class*='AnswerForm'] button:has-text('提交回答')",
  "[class*='AnswerForm'] button:has-text('更新回答')",
  "[class*='AnswerForm'] button:has-text('保存修改')",
  "[class*='AnswerForm'] button:has-text('发布修改')",
  "[class*='AnswerForm'] [role='button']:has-text('发布回答')",
  "[class*='AnswerForm'] [role='button']:has-text('提交回答')",
  "[class*='AnswerForm'] [role='button']:has-text('更新回答')",
  "[class*='AnswerForm'] [role='button']:has-text('保存修改')",
  "[class*='AnswerForm'] [role='button']:has-text('发布修改')"
];

type PublishResultReview = {
  decision: "SUCCESS" | "CONTENT_RISK" | "UNCERTAIN";
  confidence: "high" | "medium" | "low";
  matchedSignals: string[];
  reason: string;
};

type PublishContentSignals = {
  expectedExcerpt: string;
  expectedSignals: string[];
};

type ExistingDraftComparison = {
  decision: "MATCHED" | "SIMILAR" | "MISMATCH";
  expectedLength: number;
  actualLength: number;
  lengthDelta: number;
  lengthDeltaRatio: number;
  overlapScore: number;
  matchedSignalCount: number;
  reason: string;
};

type AnswerTextSegment = {
  text: string;
  bold: boolean;
};

type ZhihuRichTextPayload = {
  plainText: string;
  html: string;
  boldSignals: string[];
};

type EditorFormatComparison = {
  decision: "MATCHED" | "NOT_REQUIRED" | "MISMATCH";
  expectedBoldSignalCount: number;
  matchedBoldSignals: string[];
  reason: string;
};

export type PublishResumeAnchor = {
  stage: string;
  currentUrl?: string | null;
};

export class PublishFlowError extends Error {
  constructor(
    public readonly failureType: FailureType,
    message: string,
    public readonly currentUrl: string | null = null,
    public readonly meta: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export class PublishService {
  constructor(
    private readonly llmService: LlmService,
    private readonly browserSkillService: BrowserSkillService,
    private readonly sessionService: SessionService,
    private readonly layaService: LayaService = new LayaService()
  ) {}

  async runPublishAttempt(input: {
    sessionKey: string;
    traceGroupId: string;
    profileDir: string;
    questionUrl: string;
    content: string;
    publishJobId: number;
    publishAttemptId: number | null;
    promptSnapshot?: PromptSnapshotMap | null;
    resumeAnchor?: PublishResumeAnchor | null;
    expectedZhihuUserName?: string | null;
    accountName?: string | null;
  }) {
    const traceBase = {
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      publishJobId: input.publishJobId,
      publishAttemptId: input.publishAttemptId,
      traceGroupId: input.traceGroupId,
      agentName: "publish_agent"
    } as const;
    const richTextPayload = buildZhihuRichTextPayload(input.content);

    await this.sessionService.ensureLoggedIn({
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      traceGroupId: `${input.traceGroupId}-preflight`,
      stage: "login_checking",
      publishJobId: input.publishJobId,
      publishAttemptId: input.publishAttemptId,
      promptSnapshot: input.promptSnapshot,
      expectedZhihuUserName: input.expectedZhihuUserName ?? null,
      accountName: input.accountName ?? null
    });

    const targetUrl = input.resumeAnchor?.currentUrl ?? normalizeZhihuQuestionUrl(input.questionUrl) ?? input.questionUrl;

    await this.browserSkillService.open(
      {
        ...traceBase,
        stage: "publishing"
      },
      {
        url: targetUrl
      }
    );

    const openSnapshot = await this.browserSkillService.snapshot({
      ...traceBase,
      stage: "login_checking"
    });

    const sessionState = await this.sessionService.detectSessionState(openSnapshot, input.promptSnapshot);
    if (sessionState.session_state === "login_required" || sessionState.session_state === "session_expired") {
      throw new PublishFlowError(sessionState.session_state as FailureType, sessionState.reason, openSnapshot.url, {
        sessionState,
        resumeAnchor: {
          stage: "login_checking",
          currentUrl: openSnapshot.url
        }
      });
    }

    const openPlanState = await this.resolvePlanForStage({
      traceBase,
      stage: "publishing",
      snapshot: openSnapshot,
      promptSnapshot: input.promptSnapshot,
      expectedActions: ["CLICK_WRITE_ANSWER", "FOCUS_EDITOR", "PASTE_CONTENT", "VERIFY_RESULT"]
    });
    const openPlan = openPlanState.plan;

    if (openPlan.nextAction === "REQUEST_MANUAL_LOGIN") {
      throw new PublishFlowError("session_expired", openPlan.reason, openPlanState.snapshot.url, {
        snapshot: openPlanState.snapshot,
        publishPlan: openPlan,
        resumeAnchor: {
          stage: "login_checking",
          currentUrl: openPlanState.snapshot.url
        }
      });
    }

    const existingAnswerSignal = getExistingAnswerSignal(openPlan);
    let rawEditorSnapshot = openPlanState.snapshot;
    let editorAlreadyPrepared = false;

    if (existingAnswerSignal === "edit" || existingAnswerSignal === "view") {
      const existingAnswerResult = await this.handleExistingAnswerEntry({
        traceBase,
        snapshot: openPlanState.snapshot,
        plan: openPlan,
        content: richTextPayload.plainText,
        promptSnapshot: input.promptSnapshot,
        signal: existingAnswerSignal
      });

      if (existingAnswerResult.kind === "completed") {
        return {
          finalUrl: existingAnswerResult.finalUrl,
          screenshotPath: existingAnswerResult.screenshotPath,
          pageSnapshot: existingAnswerResult.pageSnapshot
        };
      }

      if (existingAnswerResult.kind === "uncertain") {
        throw new PublishFlowError("publish_uncertain", existingAnswerResult.reason, existingAnswerResult.currentUrl, {
          screenshotPath: existingAnswerResult.screenshotPath,
          verifySnapshot: existingAnswerResult.pageSnapshot,
          contentComparison: existingAnswerResult.comparison,
          resumeAnchor: {
            stage: "publish_verify",
            currentUrl: existingAnswerResult.currentUrl
          }
        });
      }

      rawEditorSnapshot = existingAnswerResult.editorSnapshot;
      editorAlreadyPrepared = true;
    } else if (openPlan.nextAction === "VERIFY_RESULT") {
      const existingPageResult = await this.captureAndReviewPageResult({
        traceBase,
        stage: "publish_verify",
        currentUrl: openPlanState.snapshot.url,
        snapshot: openPlanState.snapshot,
        content: richTextPayload.plainText,
        promptSnapshot: input.promptSnapshot,
        screenshotLabel: `publish-open-${input.publishJobId}`
      });

      if (existingPageResult.reviewedResult.decision === "SUCCESS") {
        return {
          finalUrl: existingPageResult.currentUrl,
          screenshotPath: existingPageResult.screenshotPath,
          pageSnapshot: existingPageResult.snapshot
        };
      }

      throw new PublishFlowError("publish_uncertain", existingPageResult.reviewedResult.reason, existingPageResult.currentUrl, {
        screenshotPath: existingPageResult.screenshotPath,
        verifySnapshot: existingPageResult.snapshot,
        reviewedResult: existingPageResult.reviewedResult,
        resumeAnchor: {
          stage: "publish_verify",
          currentUrl: existingPageResult.currentUrl
        }
      });
    } else if (openPlan.nextAction === "CLICK_WRITE_ANSWER") {
      await this.clickPlanOrThrow({
        traceBase,
        snapshot: openPlanState.snapshot,
        plan: openPlan,
        failureType: "editor_not_ready",
        errorMessage: "没有找到“写回答”入口。"
      });

      await this.browserSkillService.wait(
        {
          ...traceBase,
          stage: "publishing"
        },
        {
          ms: 2500
        }
      );

      rawEditorSnapshot = await this.ensureEditorSurface({
        traceBase,
        snapshot: await this.browserSkillService.snapshot({
          ...traceBase,
          stage: "publishing"
        }),
        promptSnapshot: input.promptSnapshot
      });
    } else if (openPlan.nextAction !== "FOCUS_EDITOR" && openPlan.nextAction !== "PASTE_CONTENT") {
      throw new PublishFlowError("editor_not_ready", openPlan.reason || "当前页面还没有进入可编辑状态。", openPlanState.snapshot.url, {
        snapshot: openPlanState.snapshot,
        publishPlan: openPlan,
        resumeAnchor: {
          stage: "publishing",
          currentUrl: openPlanState.snapshot.url
        }
      });
    }

    if (rawEditorSnapshot.url.includes("/signin") || rawEditorSnapshot.url.includes("/login")) {
      throw new PublishFlowError("login_required", "知乎要求登录后才能编辑或发布回答，当前账号会话未登录或已过期。", rawEditorSnapshot.url, {
        snapshot: rawEditorSnapshot,
        resumeAnchor: {
          stage: "login_checking",
          currentUrl: rawEditorSnapshot.url
        }
      });
    }

    let editorSnapshot = rawEditorSnapshot;
    let editorPlan: PublishStepPlan;

    if (editorAlreadyPrepared) {
      editorPlan = {
        nextAction: "PASTE_CONTENT",
        targetTexts: [],
        targetRoles: [],
        targetSelectors: EDITOR_SELECTORS,
        confidence: "high",
        reason: "已在编辑态完成旧内容清空，直接重新粘贴全文。"
      };
    } else {
      const editorPlanState = await this.resolvePlanForStage({
        traceBase,
        stage: "publishing",
        snapshot: await this.ensureEditorSurface({
          traceBase,
          snapshot: rawEditorSnapshot,
          promptSnapshot: input.promptSnapshot
        }),
        promptSnapshot: input.promptSnapshot,
        expectedActions: ["FOCUS_EDITOR", "PASTE_CONTENT"]
      });
      editorSnapshot = editorPlanState.snapshot;
      editorPlan = editorPlanState.plan;

      if (editorPlan.nextAction === "REQUEST_MANUAL_LOGIN") {
        throw new PublishFlowError("session_expired", editorPlan.reason, editorPlanState.snapshot.url, {
          snapshot: editorPlanState.snapshot,
          publishPlan: editorPlan,
          resumeAnchor: {
            stage: "login_checking",
            currentUrl: editorPlanState.snapshot.url
          }
        });
      }

      if (editorPlan.nextAction !== "FOCUS_EDITOR" && editorPlan.nextAction !== "PASTE_CONTENT") {
        throw new PublishFlowError("editor_not_ready", editorPlan.reason || "没有进入可编辑的回答区域。", editorPlanState.snapshot.url, {
          snapshot: editorPlanState.snapshot,
          publishPlan: editorPlan,
          resumeAnchor: {
            stage: "publishing",
            currentUrl: editorPlanState.snapshot.url
          }
        });
      }
    }

    await this.focusEditorOrThrow(traceBase, editorSnapshot, editorPlan);

    if (editorSnapshot.editorContent && editorSnapshot.editorContent.trim().length > 0) {
      await this.browserSkillService.press(
        { ...traceBase, stage: "publishing" },
        { key: process.platform === "darwin" ? "Meta+A" : "Control+A" }
      );
      await this.browserSkillService.press(
        { ...traceBase, stage: "publishing" },
        { key: "Backspace" }
      );
      await this.browserSkillService.wait({ ...traceBase, stage: "publishing" }, { ms: 300 });
    }

    await this.pasteAnswerContent(
      {
        ...traceBase,
        stage: "publishing"
      },
      richTextPayload
    );

    await this.browserSkillService.wait(
      {
        ...traceBase,
        stage: "publishing"
      },
      {
        ms: 1000
      }
    );

    const afterPasteSnapshot = await this.browserSkillService.snapshot({
      ...traceBase,
      stage: "publishing"
    });
    const editorComparison = compareExistingDraftToExpected(afterPasteSnapshot, richTextPayload.plainText);
    if (editorComparison.decision !== "MATCHED") {
      throw new PublishFlowError(
        "editor_not_ready",
        `编辑器内容未完整写入：${editorComparison.reason}`,
        afterPasteSnapshot.url,
        {
          snapshot: afterPasteSnapshot,
          editorComparison,
          resumeAnchor: {
            stage: "publishing",
            currentUrl: afterPasteSnapshot.url
          }
        }
      );
    }

    const editorFormatComparison = compareEditorRichFormatting(afterPasteSnapshot, richTextPayload.boldSignals);
    if (editorFormatComparison.decision === "MISMATCH") {
      console.warn(
        `[PublishService] 编辑器富文本格式校验提示（非致命）：${editorFormatComparison.reason}。正文已完整写入（匹配度 ${Math.round(editorComparison.overlapScore * 100)}%），继续推进提交。`
      );
    }

    return this.submitWithRecovery({
      traceBase,
      snapshot: afterPasteSnapshot,
      content: richTextPayload.plainText,
      promptSnapshot: input.promptSnapshot
    });
  }

  /**
   * Bounded recovery loop for layout changes and transient editor states.
   * It may observe, scroll, re-plan and reload, but never bypasses login,
   * challenge or risk gates and never clicks submit twice without verification.
   */
  private async submitWithRecovery(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    content: string;
    promptSnapshot?: PromptSnapshotMap | null;
  }) {
    let snapshot = input.snapshot;
    let lastPlan: PublishStepPlan | null = null;
    const recoveryTrace: string[] = [];

    for (let step = 0; step < 6; step += 1) {
      const surface = await this.ensureSubmitSurface({
        traceBase: input.traceBase,
        snapshot,
        promptSnapshot: input.promptSnapshot
      });
      const planState = await this.resolvePlanForStage({
        traceBase: input.traceBase,
        stage: "publishing",
        snapshot: surface,
        promptSnapshot: input.promptSnapshot,
        expectedActions: ["CLICK_SUBMIT"]
      });
      snapshot = planState.snapshot;
      lastPlan = planState.plan;

      if (lastPlan.nextAction === "REQUEST_MANUAL_LOGIN") {
        throw new PublishFlowError("challenge_required", lastPlan.reason, snapshot.url, {
          snapshot,
          publishPlan: lastPlan,
          recoveryTrace
        });
      }

      if (lastPlan.nextAction === "VERIFY_RESULT") {
        return this.collectVerifiedPublishResult(input.traceBase, input.traceBase.publishJobId, input.content, input.promptSnapshot);
      }

      const clicked = await this.trySubmitClick(input.traceBase, lastPlan);
      if (clicked) {
        recoveryTrace.push(`step_${step}:click_submit`);
        await this.browserSkillService.wait({ ...input.traceBase, stage: "publish_verify" }, { ms: 3500 });
        try {
          return await this.collectVerifiedPublishResult(input.traceBase, input.traceBase.publishJobId, input.content, input.promptSnapshot);
        } catch (error) {
          if (!(error instanceof PublishFlowError) || error.failureType !== "publish_uncertain") {
            throw error;
          }
          recoveryTrace.push(`step_${step}:verify_uncertain`);
          snapshot = await this.browserSkillService.snapshot({ ...input.traceBase, stage: "publish_verify" });
          if (isTerminalPublishState(snapshot)) {
            throw error;
          }
        }
      } else {
        recoveryTrace.push(`step_${step}:submit_target_missing`);
        const failure = await this.layaService.classifyPublishFailure({
          currentUrl: snapshot.url,
          title: snapshot.title,
          buttons: snapshot.buttons,
          visibleTexts: snapshot.visibleTexts,
          editorStillVisible: hasEditorSemantic(snapshot),
          lastAction: "CLICK_SUBMIT",
          lastError: lastPlan.reason
        });
        if (failure) {
          recoveryTrace.push(`laya:${failure.failureType}:${failure.confidence}`);
          if (failure.failureType === "LOGIN_REQUIRED" || failure.failureType === "CAPTCHA_REQUIRED" || failure.failureType === "RISK_CONTROL") {
            throw new PublishFlowError("challenge_required", failure.reason, snapshot.url, {
              snapshot,
              recoveryTrace,
              layaFailure: failure,
              resumeAnchor: { stage: "publishing", currentUrl: snapshot.url }
            });
          }
          if (failure.failureType === "NETWORK_TIMEOUT") {
            await this.browserSkillService.wait({ ...input.traceBase, stage: "publishing" }, { ms: 1800 });
          }
        }
      }

      if (step === 1) {
        await this.browserSkillService.scroll({ ...input.traceBase, stage: "publishing" }, { direction: "bottom" });
        recoveryTrace.push("scroll_bottom");
      } else if (step === 2) {
        await this.browserSkillService.scroll({ ...input.traceBase, stage: "publishing" }, { direction: "top" });
        recoveryTrace.push("scroll_top");
      } else if (step === 3) {
        await this.browserSkillService.reload({ ...input.traceBase, stage: "publishing" });
        recoveryTrace.push("reload_page");
        await this.browserSkillService.wait({ ...input.traceBase, stage: "publishing" }, { ms: 1800 });
      } else {
        await this.browserSkillService.wait({ ...input.traceBase, stage: "publishing" }, { ms: 1000 + step * 300 });
      }

      snapshot = await this.browserSkillService.snapshot({ ...input.traceBase, stage: "publishing" });
      if (isManualGateState(snapshot)) {
        throw new PublishFlowError("challenge_required", "页面出现登录、安全验证或验证码，需要人工处理。", snapshot.url, {
          snapshot,
          recoveryTrace,
          resumeAnchor: { stage: "publishing", currentUrl: snapshot.url }
        });
      }
    }

    throw new PublishFlowError("submit_not_ready", "发布 Agent 已完成有限恢复尝试，仍未找到可确认的发布入口。", snapshot.url, {
      snapshot,
      publishPlan: lastPlan,
      recoveryTrace,
      resumeAnchor: { stage: "publishing", currentUrl: snapshot.url }
    });
  }

  private async trySubmitClick(
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    },
    plan: PublishStepPlan
  ) {
    const names = sanitizeSubmitTargets(plan.targetTexts);
    const targetNames = names.length ? names : SUBMIT_TEXT_CANDIDATES;
    try {
      await this.browserSkillService.click(
        { ...traceBase, stage: "publishing" },
        {
          names: targetNames,
          roles: plan.targetRoles.length ? plan.targetRoles : ["button", "link"],
          selectors: mergeSelectors(plan.targetSelectors, DIRECT_SUBMIT_SELECTORS)
        }
      );
      return true;
    } catch {
      return this.tryDirectSubmitClick(traceBase);
    }
  }

  private async pasteAnswerContent(context: BrowserSkillContext, payload: ZhihuRichTextPayload) {
    await this.browserSkillService.pasteRichText(context, {
      text: payload.plainText,
      html: payload.html
    });
  }

  private async collectVerifiedPublishResult(
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    },
    publishJobId: number,
    content: string,
    promptSnapshot?: PromptSnapshotMap | null
  ) {
    const finalUrlResult = await this.browserSkillService.getUrl({
      ...traceBase,
      stage: "publish_verify"
    });
    const verifySnapshot = await this.browserSkillService.snapshot({
      ...traceBase,
      stage: "publish_verify"
    });
    const screenshot = await this.browserSkillService.screenshot(
      {
        ...traceBase,
        stage: "publish_verify"
      },
      {
        label: `publish-job-${publishJobId}`
      }
    );

    const reviewedResult = await this.reviewPublishResult(
      verifySnapshot,
      finalUrlResult.url,
      content,
      promptSnapshot
    );

    if (reviewedResult.decision === "CONTENT_RISK") {
      throw new PublishFlowError("content_risk_block", reviewedResult.reason, finalUrlResult.url, {
        screenshotPath: screenshot.screenshotPath,
        verifySnapshot,
        reviewedResult,
        resumeAnchor: {
          stage: "publish_verify",
          currentUrl: finalUrlResult.url
        }
      });
    }

    if (reviewedResult.decision !== "SUCCESS") {
      throw new PublishFlowError("publish_uncertain", reviewedResult.reason, finalUrlResult.url, {
        screenshotPath: screenshot.screenshotPath,
        verifySnapshot,
        reviewedResult,
        resumeAnchor: {
          stage: "publish_verify",
          currentUrl: finalUrlResult.url
        }
      });
    }

    return {
      finalUrl: finalUrlResult.url,
      screenshotPath: screenshot.screenshotPath,
      pageSnapshot: verifySnapshot
    };
  }

  async closeSession(sessionKey: string) {
    await this.browserSkillService.closeSession(sessionKey);
  }

  scheduleSessionClose(sessionKey: string, delayMs: number) {
    this.browserSkillService.scheduleSessionClose(sessionKey, delayMs);
  }

  async closeAllSessions() {
    await this.browserSkillService.closeAllSessions();
  }

  hasOpenSession(sessionKey: string) {
    return this.browserSkillService.hasSession(sessionKey);
  }

  async restartSession(input: { sessionKey: string; profileDir: string; traceGroupId?: string }) {
    await this.browserSkillService.restartSession({
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      traceGroupId: input.traceGroupId
    });
  }

  async verifyExistingResult(input: {
    sessionKey: string;
    traceGroupId: string;
    profileDir: string;
    publishJobId: number;
    publishAttemptId: number | null;
    currentUrl: string;
    content: string;
    promptSnapshot?: PromptSnapshotMap | null;
    expectedZhihuUserName?: string | null;
    accountName?: string | null;
  }) {
    const traceBase = {
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      publishJobId: input.publishJobId,
      publishAttemptId: input.publishAttemptId,
      traceGroupId: input.traceGroupId,
      agentName: "publish_agent"
    } as const;

    await this.sessionService.ensureLoggedIn({
      sessionKey: input.sessionKey,
      profileDir: input.profileDir,
      traceGroupId: `${input.traceGroupId}-preflight`,
      stage: "login_checking",
      publishJobId: input.publishJobId,
      publishAttemptId: input.publishAttemptId,
      promptSnapshot: input.promptSnapshot,
      expectedZhihuUserName: input.expectedZhihuUserName ?? null,
      accountName: input.accountName ?? null
    });

    await this.browserSkillService.open(
      {
        ...traceBase,
        stage: "publish_verify"
      },
      {
        url: input.currentUrl
      }
    );

    await this.browserSkillService.wait(
      {
        ...traceBase,
        stage: "publish_verify"
      },
      {
        ms: 1800
      }
    );

    const reviewedPage = await this.captureAndReviewPageResult({
      traceBase,
      stage: "publish_verify",
      content: input.content,
      promptSnapshot: input.promptSnapshot,
      screenshotLabel: `publish-verify-${input.publishJobId}`
    });

    return {
      ok: reviewedPage.reviewedResult.decision === "SUCCESS",
      reason: reviewedPage.reviewedResult.reason,
      finalUrl: reviewedPage.currentUrl,
      screenshotPath: reviewedPage.screenshotPath
    };
  }

  private async captureAndReviewPageResult(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    stage: "publishing" | "publish_verify";
    currentUrl?: string;
    snapshot?: PageSnapshot;
    content: string;
    promptSnapshot?: PromptSnapshotMap | null;
    screenshotLabel: string;
  }) {
    let currentUrl =
      input.currentUrl ??
      (
        await this.browserSkillService.getUrl({
          ...input.traceBase,
          stage: input.stage
        })
      ).url;

    let snapshot =
      input.snapshot ??
      (await this.browserSkillService.snapshot({
        ...input.traceBase,
        stage: input.stage
      }));

    const myAnswerUrl = pickMyAnswerDetailUrl(snapshot, currentUrl);
    if (myAnswerUrl && myAnswerUrl !== currentUrl) {
      await this.browserSkillService.open(
        {
          ...input.traceBase,
          stage: "publish_verify"
        },
        {
          url: myAnswerUrl
        }
      );

      await this.browserSkillService.wait(
        {
          ...input.traceBase,
          stage: "publish_verify"
        },
        {
          ms: 1200
        }
      );

      currentUrl = myAnswerUrl;
      snapshot = await this.browserSkillService.snapshot({
        ...input.traceBase,
        stage: "publish_verify"
      });
    }

    const screenshot = await this.browserSkillService.screenshot(
      {
        ...input.traceBase,
        stage: input.stage
      },
      {
        label: input.screenshotLabel
      }
    );

    const reviewedResult = await this.reviewPublishResult(snapshot, currentUrl, input.content, input.promptSnapshot);

    return {
      currentUrl,
      snapshot,
      screenshotPath: screenshot.screenshotPath,
      reviewedResult
    };
  }

  private async resolvePlanForStage(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    stage: "publishing" | "publish_verify";
    snapshot: PageSnapshot;
    promptSnapshot?: PromptSnapshotMap | null;
    expectedActions: PublishStepAction[];
  }) {
    let snapshot = input.snapshot;
    let plan = await this.understandPublishPage(snapshot, input.promptSnapshot);
    plan = coerceManualLoginPlan(snapshot, input.expectedActions, plan);

    if (plan.nextAction === "REQUEST_MANUAL_LOGIN" || input.expectedActions.includes(plan.nextAction)) {
      return { snapshot, plan };
    }

    if ((input.expectedActions.includes("FOCUS_EDITOR") || input.expectedActions.includes("PASTE_CONTENT")) && hasEditorSemantic(snapshot)) {
      const editorFastPlan: PublishStepPlan = {
        nextAction: "FOCUS_EDITOR",
        targetTexts: [],
        targetRoles: [],
        targetSelectors: EDITOR_SELECTORS,
        confidence: "high",
        reason: "检测到页面已具备编辑器DOM，按预期流直接进入FOCUS_EDITOR。"
      };
      return {
        snapshot,
        plan: editorFastPlan
      };
    }

    const firstFallbackPlan = buildFallbackPublishPlan(snapshot, input.expectedActions);
    if (firstFallbackPlan) {
      return {
        snapshot,
        plan: firstFallbackPlan
      };
    }

    if (plan.nextAction === "WAIT" || (plan.nextAction === "FOCUS_EDITOR" && input.expectedActions.includes("CLICK_SUBMIT"))) {
      await this.browserSkillService.wait(
        {
          ...input.traceBase,
          stage: input.stage
        },
        { ms: 1200 }
      );

      snapshot = await this.browserSkillService.snapshot({
        ...input.traceBase,
        stage: input.stage
      });
      plan = await this.understandPublishPage(snapshot, input.promptSnapshot);
      plan = coerceManualLoginPlan(snapshot, input.expectedActions, plan);

      if (plan.nextAction === "REQUEST_MANUAL_LOGIN" || input.expectedActions.includes(plan.nextAction)) {
        return { snapshot, plan };
      }

      const secondFallbackPlan = buildFallbackPublishPlan(snapshot, input.expectedActions);
      if (secondFallbackPlan) {
        return {
          snapshot,
          plan: secondFallbackPlan
        };
      }
    }

    return { snapshot, plan };
  }

  private async understandPublishPage(snapshot: PageSnapshot, promptSnapshot?: PromptSnapshotMap | null): Promise<PublishStepPlan> {
    // 优先尝试本地 Laya 决策加速 (25ms)
    try {
      const layaPlan = await this.layaService.understandPublishPage(snapshot);
      if (layaPlan && layaPlan.nextAction !== "WAIT") {
        if (layaPlan.nextAction === "CLICK_WRITE_ANSWER" && (!layaPlan.targetSelectors || layaPlan.targetSelectors.length === 0)) {
          layaPlan.targetSelectors = [
            "button:has-text('编辑回答')",
            "button:has-text('写回答')",
            "button.WriteAnswerButton",
            ".QuestionHeaderActions button:has-text('编辑回答')",
            ".QuestionHeaderActions button:has-text('写回答')",
            ".QuestionHeaderActions button.WriteAnswerButton"
          ];
        }
        if ((layaPlan.nextAction === "FOCUS_EDITOR" || layaPlan.nextAction === "PASTE_CONTENT") && (!layaPlan.targetSelectors || layaPlan.targetSelectors.length === 0)) {
          layaPlan.targetSelectors = EDITOR_SELECTORS;
        }
        return layaPlan;
      }
    } catch {
      // 异常自动平滑降级至下方的 LLM 兜底
    }

    const publishPrompt = await this.llmService.resolvePrompt("publish_agent", {
      promptSnapshot
    });

    const result = await this.llmService.runJsonWithSystemPrompt<PublishStepPlan>(
      `${publishPrompt}

补充说明：
你现在执行的是 Publish Agent 的“发布页理解任务”。
任务目标：
根据当前知乎页面快照，判断发布流程下一步最合理的动作。

可选 nextAction 只有：
1. CLICK_WRITE_ANSWER
2. FOCUS_EDITOR
3. PASTE_CONTENT
4. CLICK_SUBMIT
5. WAIT
6. VERIFY_RESULT
7. REQUEST_MANUAL_LOGIN

判断规则：
1. 如果页面出现登录、挑战、风控、安全验证、人机验证，输出 REQUEST_MANUAL_LOGIN。
2. 先看 snapshot.buttons 和 snapshot.links。当前是问题页，且其中出现「写回答」（允许前面有零宽字符或空白），必须输出 CLICK_WRITE_ANSWER。这是默认路径。
3. 不要因为 visibleTexts、标题、评论、侧栏里出现「我的回答」「查看我的回答」就输出 VERIFY_RESULT。那不是本账号已经回答过的证据。
4. 只有 buttons 或 links 上的可点击文案就是「查看我的回答」或「编辑回答」，或当前 URL 已是 /question/.../answer/... 时，才输出 VERIFY_RESULT。
5. 不要选择「邀请回答」。
6. 已经进入回答编辑态时，输出 FOCUS_EDITOR 或 PASTE_CONTENT。
7. 编辑态下能识别到「发布回答」时，输出 CLICK_SUBMIT。
8. targetTexts 必须从 snapshot.buttons 或 snapshot.links 原样复制，保留零宽字符，不要改写成干净文案。targetRoles 只允许 button 或 link。
9. 证据不足时才输出 WAIT。
10. 只输出 JSON，不要解释，不要 Markdown。

输出格式：
{
  "nextAction": "CLICK_WRITE_ANSWER | FOCUS_EDITOR | PASTE_CONTENT | CLICK_SUBMIT | WAIT | VERIFY_RESULT | REQUEST_MANUAL_LOGIN",
  "targetTexts": ["写回答"],
  "targetRoles": ["button"],
  "targetSelectors": [],
  "confidence": "high | medium | low",
  "reason": "一句话说明原因"
}`,
      snapshot,
      {
        nextAction: "WAIT",
        targetTexts: [],
        targetRoles: [],
        targetSelectors: [],
        confidence: "low",
        reason: ""
      }
    );

    return {
      nextAction: result.nextAction ?? "WAIT",
      targetTexts: Array.isArray(result.targetTexts) ? result.targetTexts.map((item: unknown) => String(item)) : [],
      targetRoles: Array.isArray(result.targetRoles)
        ? result.targetRoles.filter((item: unknown): item is "button" | "link" => item === "button" || item === "link")
        : [],
      targetSelectors: Array.isArray(result.targetSelectors)
        ? result.targetSelectors.map((item: unknown) => String(item))
        : [],
      confidence: result.confidence === "high" || result.confidence === "medium" ? result.confidence : "low",
      reason: typeof result.reason === "string" ? result.reason : ""
    };
  }

  private async reviewPublishResult(
    snapshot: PageSnapshot,
    currentUrl: string,
    content: string,
    promptSnapshot?: PromptSnapshotMap | null
  ) {
    const contentSignals = buildPublishContentSignals(content);
    const initialMatchedSignals = findMatchedExpectedSignals(snapshot, contentSignals.expectedSignals);
    const initialEditorStillVisible = hasEditorSemantic(snapshot);

    // 优先尝试本地 Laya 快速核验 (25ms)
    try {
      const layaReview = await this.layaService.reviewPublishResult({
        currentUrl,
        title: snapshot.title,
        matchedSignals: initialMatchedSignals,
        editorStillVisible: initialEditorStillVisible,
        visibleTexts: snapshot.visibleTexts,
        expectedExcerpt: contentSignals.expectedExcerpt
      });
      if (layaReview && layaReview.decision !== "UNCERTAIN") {
        return {
          decision: layaReview.decision,
          confidence: layaReview.confidence,
          matchedSignals: mergeMatchedSignals(layaReview.matchedSignals, initialMatchedSignals),
          reason: layaReview.reason
        };
      }
    } catch {
      // 异常自动平滑降级至下方的 LLM 兜底
    }

    const publishPrompt = await this.llmService.resolvePrompt("publish_agent", {
      promptSnapshot
    });

    const result = await this.llmService.runJsonWithSystemPrompt<PublishResultReview>(
      `${publishPrompt}

补充说明：
你现在执行的是 Publish Agent 的“发布结果判断任务”。
任务目标：
结合页面快照、当前 URL，以及本次待发内容的关键片段，判断发布是否成功。

判断规则：
1. 如果页面明确显示内容风险、发布失败、违规拦截、审核拦截，输出 CONTENT_RISK。
2. 不能只凭 URL 判断成功。页面里随口出现「我的回答」也不够。
3. 还停留在编辑器、当前 URL 不是 /answer/ 详情页，不能输出 SUCCESS。
4. 成功至少要有：已发布区域出现本次正文关键片段，或 URL 已是本账号回答详情且不是编辑态。
5. 证据不足时输出 UNCERTAIN。
6. matchedSignals 尽量返回你命中的成功信号、风险信号或内容片段提示。
7. 只输出 JSON，不要解释，不要 Markdown。

输出格式：
{
  "decision": "SUCCESS | CONTENT_RISK | UNCERTAIN",
  "confidence": "high | medium | low",
  "matchedSignals": ["查看我的回答"],
  "reason": "一句话说明原因"
}`,
      {
        snapshot,
        currentUrl,
        expectedContentExcerpt: contentSignals.expectedExcerpt,
        expectedContentSignals: contentSignals.expectedSignals
      },
      {
        decision: "UNCERTAIN",
        confidence: "low",
        matchedSignals: [],
        reason: ""
      }
    );

    const matchedSignals = mergeMatchedSignals(
      Array.isArray(result.matchedSignals) ? result.matchedSignals.map((item: unknown) => String(item)) : [],
      findMatchedExpectedSignals(snapshot, contentSignals.expectedSignals)
    );
    const hasPublishedSemantic = hasPublishedAnswerSemantic(snapshot);
    const editorStillVisible = hasEditorSemantic(snapshot);
    const answerDetailUrl = isAnswerDetailUrl(currentUrl);

    const decision =
      result.decision === "SUCCESS" || result.decision === "CONTENT_RISK" || result.decision === "UNCERTAIN"
        ? result.decision
        : "UNCERTAIN";

    if (decision === "SUCCESS" && editorStillVisible && !answerDetailUrl) {
      return {
        decision: "UNCERTAIN" as const,
        confidence: "low" as const,
        matchedSignals,
        reason: "页面仍停留在编辑态，且当前 URL 不是回答详情页，暂时不能判定为发布成功。"
      };
    }

    if (decision === "SUCCESS" && matchedSignals.length === 0) {
      return {
        decision: "UNCERTAIN" as const,
        confidence: "low" as const,
        matchedSignals,
        reason:
          typeof result.reason === "string" && result.reason
            ? `${result.reason}；但页面里还没有命中本次待发内容的关键片段。`
            : "页面尚未命中本次待发内容的关键片段，暂时不能判定为发布成功。"
      };
    }

    return {
      decision,
      confidence: result.confidence === "high" || result.confidence === "medium" ? result.confidence : "low",
      matchedSignals,
      reason: typeof result.reason === "string" && result.reason ? result.reason : "发布结果暂时无法确认。"
    };
  }

  private async handleExistingAnswerEntry(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    plan: PublishStepPlan;
    content: string;
    promptSnapshot?: PromptSnapshotMap | null;
    signal: "view" | "edit";
  }): Promise<
    | {
        kind: "completed";
        finalUrl: string;
        screenshotPath: string;
        pageSnapshot: PageSnapshot;
      }
    | {
        kind: "uncertain";
        reason: string;
        currentUrl: string;
        screenshotPath: string | null;
        pageSnapshot: PageSnapshot;
        comparison: ExistingDraftComparison;
      }
    | {
        kind: "continue_editing";
        editorSnapshot: PageSnapshot;
      }
  > {
    await this.clickPlanOrThrow({
      traceBase: input.traceBase,
      snapshot: input.snapshot,
      plan: input.plan,
      failureType: "editor_not_ready",
      errorMessage: "没有找到“查看我的回答”或“编辑回答”的入口。"
    });

    await this.browserSkillService.wait(
      {
        ...input.traceBase,
        stage: "publishing"
      },
      {
        ms: input.signal === "edit" ? 2000 : 2500
      }
    );

    const existingSnapshot = await this.browserSkillService.snapshot({
      ...input.traceBase,
      stage: "publishing"
    });
    const comparison = compareExistingDraftToExpected(existingSnapshot, input.content);

    if (comparison.decision === "MATCHED") {
      const matchedOnAnswerDetail = isAnswerDetailUrl(existingSnapshot.url) && !hasEditorSemantic(existingSnapshot);
      if (!matchedOnAnswerDetail) {
        const editorSnapshot = await this.prepareEditorForRepaste({
          traceBase: input.traceBase,
          snapshot: existingSnapshot,
          promptSnapshot: input.promptSnapshot
        });

        return {
          kind: "continue_editing",
          editorSnapshot
        };
      }

      const verifiedPage = await this.captureAndReviewPageResult({
        traceBase: input.traceBase,
        stage: "publish_verify",
        currentUrl: existingSnapshot.url,
        snapshot: existingSnapshot,
        content: input.content,
        promptSnapshot: input.promptSnapshot,
        screenshotLabel: `publish-existing-match-${input.traceBase.publishJobId}`
      });

      return {
        kind: "completed",
        finalUrl: verifiedPage.currentUrl,
        screenshotPath: verifiedPage.screenshotPath,
        pageSnapshot: verifiedPage.snapshot
      };
    }

    if (comparison.decision === "SIMILAR") {
      return {
        kind: "uncertain",
        reason: `页面里已存在接近的回答内容，需要人工核对后再决定是否覆盖重发。${comparison.reason}`,
        currentUrl: existingSnapshot.url,
        screenshotPath: null,
        pageSnapshot: existingSnapshot,
        comparison
      };
    }

    const editorSnapshot = await this.prepareEditorForRepaste({
      traceBase: input.traceBase,
      snapshot: existingSnapshot,
      promptSnapshot: input.promptSnapshot
    });

    return {
      kind: "continue_editing",
      editorSnapshot
    };
  }

  private async prepareEditorForRepaste(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    promptSnapshot?: PromptSnapshotMap | null;
  }) {
    let currentSnapshot = input.snapshot;
    if (!hasEditorSemantic(currentSnapshot)) {
      currentSnapshot = await this.ensureEditorSurface({
        traceBase: input.traceBase,
        snapshot: currentSnapshot,
        promptSnapshot: input.promptSnapshot
      });
    }
    const editorPlan: PublishStepPlan = {
      nextAction: "FOCUS_EDITOR",
      targetTexts: [],
      targetRoles: [],
      targetSelectors: EDITOR_SELECTORS,
      confidence: "high",
      reason: "直接聚焦回答输入区域准备清空重填。"
    };
    await this.focusEditorOrThrow(input.traceBase, currentSnapshot, editorPlan);

    await this.browserSkillService.press(
      {
        ...input.traceBase,
        stage: "publishing"
      },
      {
        key: "Control+A"
      }
    );

    await this.browserSkillService.press(
      {
        ...input.traceBase,
        stage: "publishing"
      },
      {
        key: "Backspace"
      }
    );

    await this.browserSkillService.wait(
      {
        ...input.traceBase,
        stage: "publishing"
      },
      {
        ms: 500
      }
    );

    return this.browserSkillService.snapshot({
      ...input.traceBase,
      stage: "publishing"
    });
  }

  private async ensureEditorSurface(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    promptSnapshot?: PromptSnapshotMap | null;
  }) {
    let snapshot = input.snapshot;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (hasEditorSemantic(snapshot) || hasSubmitSemantic(snapshot)) {
        return snapshot;
      }

      if (snapshot.url.includes("/signin") || snapshot.url.includes("/login")) {
        return snapshot;
      }

      // Priority 1: Direct navigation to /write url (fast, 100% reliable, avoids DOM overlay/pointer-events pitfalls)
      if (snapshot.url.includes("/question/") && !snapshot.url.includes("/write")) {
        const writeUrl = `${snapshot.url.split('?')[0].replace(/\/$/, '')}/write`;
        try {
          await this.browserSkillService.open({ ...input.traceBase, stage: "publishing" }, { url: writeUrl });
          await this.browserSkillService.wait({ ...input.traceBase, stage: "publishing" }, { ms: 2500 });
          snapshot = await this.browserSkillService.snapshot({ ...input.traceBase, stage: "publishing" });
          if (hasEditorSemantic(snapshot) || hasSubmitSemantic(snapshot) || snapshot.url.includes("/signin")) {
            return snapshot;
          }
        } catch {
          // If direct open fails, fall through to button click
        }
      }

      // Priority 2: Click "写回答" / "编辑回答" button
      const writeAnswerPlan = buildFallbackPublishPlan(snapshot, ["CLICK_WRITE_ANSWER"]);
      if (writeAnswerPlan?.nextAction === "CLICK_WRITE_ANSWER") {
        try {
          await this.clickPlanOrThrow({
            traceBase: input.traceBase,
            snapshot,
            plan: writeAnswerPlan,
            failureType: "editor_not_ready",
            errorMessage: "没有找到“写回答”入口。"
          });
        } catch (clickErr) {
          // If button click threw, try direct /write before giving up
          if (snapshot.url.includes("/question/") && !snapshot.url.includes("/write")) {
            const writeUrl = `${snapshot.url.split('?')[0].replace(/\/$/, '')}/write`;
            await this.browserSkillService.open({ ...input.traceBase, stage: "publishing" }, { url: writeUrl });
            await this.browserSkillService.wait({ ...input.traceBase, stage: "publishing" }, { ms: 2500 });
            snapshot = await this.browserSkillService.snapshot({ ...input.traceBase, stage: "publishing" });
            if (hasEditorSemantic(snapshot) || hasSubmitSemantic(snapshot) || snapshot.url.includes("/signin")) {
              return snapshot;
            }
          }
          throw clickErr;
        }
      }

      await this.browserSkillService.wait(
        {
          ...input.traceBase,
          stage: "publishing"
        },
        {
          ms: attempt === 0 ? 1800 : 2400
        }
      );

      snapshot = await this.browserSkillService.snapshot({
        ...input.traceBase,
        stage: "publishing"
      });

      if (hasEditorSemantic(snapshot) || hasSubmitSemantic(snapshot) || snapshot.url.includes("/signin")) {
        return snapshot;
      }
    }

    return snapshot;
  }

  private async ensureSubmitSurface(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    promptSnapshot?: PromptSnapshotMap | null;
  }) {
    let snapshot = input.snapshot;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (hasSubmitSemantic(snapshot) && hasEditorSemantic(snapshot)) {
        return snapshot;
      }

      if (!hasEditorSemantic(snapshot)) {
        snapshot = await this.ensureEditorSurface(input);
        if (hasSubmitSemantic(snapshot) && hasEditorSemantic(snapshot)) {
          return snapshot;
        }
      }

      await this.browserSkillService.wait(
        {
          ...input.traceBase,
          stage: "publishing"
        },
        {
          ms: 1200
        }
      );

      snapshot = await this.browserSkillService.snapshot({
        ...input.traceBase,
        stage: "publishing"
      });
    }

    return snapshot;
  }

  private async focusEditorOrThrow(
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    },
    snapshot: PageSnapshot,
    plan: PublishStepPlan
  ) {
    const selectors = mergeSelectors(plan.targetSelectors, EDITOR_SELECTORS);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.browserSkillService.focus(
          {
            ...traceBase,
            stage: "publishing"
          },
          {
            selectors
          }
        );
        return;
      } catch {
        if (attempt === 0) {
          await this.browserSkillService.wait(
            {
              ...traceBase,
              stage: "publishing"
            },
            {
              ms: 1200
            }
          );
        }
      }
    }

    throw new PublishFlowError("editor_not_ready", "没有找到可编辑的输入区域。", snapshot.url, {
      snapshot,
      publishPlan: plan,
      resumeAnchor: {
        stage: "publishing",
        currentUrl: snapshot.url
      }
    });
  }

  private async clickPlanOrThrow(input: {
    traceBase: {
      sessionKey: string;
      profileDir: string;
      publishJobId: number;
      publishAttemptId: number | null;
      traceGroupId: string;
      agentName: "publish_agent";
    };
    snapshot: PageSnapshot;
    plan: PublishStepPlan;
    failureType: FailureType;
    errorMessage: string;
  }) {
    try {
      await this.browserSkillService.click(
        {
          ...input.traceBase,
          stage: "publishing"
        },
        {
          names: input.plan.targetTexts,
          roles: input.plan.targetRoles.length ? input.plan.targetRoles : ["button", "link"],
          selectors: input.plan.targetSelectors
        }
      );
    } catch {
      throw new PublishFlowError(input.failureType, input.errorMessage, input.snapshot.url, {
        snapshot: input.snapshot,
        publishPlan: input.plan,
        resumeAnchor: {
          stage: "publishing",
          currentUrl: input.snapshot.url
        }
      });
    }
  }

  private async tryDirectSubmitClick(traceBase: {
    sessionKey: string;
    profileDir: string;
    publishJobId: number;
    publishAttemptId: number | null;
    traceGroupId: string;
    agentName: "publish_agent";
  }) {
    try {
      await this.browserSkillService.click(
        {
          ...traceBase,
          stage: "publishing"
        },
        {
          names: SUBMIT_TEXT_CANDIDATES,
          roles: ["button", "link"],
          selectors: DIRECT_SUBMIT_SELECTORS
        }
      );
      return true;
    } catch {
      return false;
    }
  }
}

function mergeSelectors(primary: string[], fallback: string[]) {
  return Array.from(new Set([...primary, ...fallback].filter(Boolean)));
}

function isManualGateState(snapshot: PageSnapshot) {
  const text = [snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons].join(" ").toLowerCase();
  return (
    snapshot.url.includes("/signin") ||
    snapshot.url.includes("/login") ||
    /验证码|安全验证|人机验证|登录后|请完成验证|unhuman|captcha|security check/.test(text)
  );
}

function isTerminalPublishState(snapshot: PageSnapshot) {
  return isManualGateState(snapshot) || /风控|违规|风险提示|内容审核/.test([snapshot.title, ...snapshot.visibleTexts].join(" "));
}

function buildFallbackPublishPlan(snapshot: PageSnapshot, expectedActions: PublishStepAction[]): PublishStepPlan | null {
  const combinedTexts = [
    snapshot.title,
    ...snapshot.visibleTexts,
    ...snapshot.buttons,
    ...snapshot.links.map((item) => item.text)
  ]
    .map((item) => item.trim())
    .filter(Boolean);

  if (expectedActions.includes("VERIFY_RESULT")) {
    const existingAnswerText = findFirstMatchingText(combinedTexts, ["查看我的回答", "我的回答"]);
    if (existingAnswerText) {
      return {
        nextAction: "VERIFY_RESULT",
        targetTexts: [existingAnswerText],
        targetRoles: ["button", "link"],
        targetSelectors: [],
        confidence: "high",
        reason: "页面已经出现当前账号的回答语义，先按已回答状态核验结果。"
      };
    }
  }

  if (expectedActions.includes("CLICK_WRITE_ANSWER")) {
    const writeAnswerText = findFirstMatchingText(combinedTexts, ["写回答", "编辑回答", "继续写"]);
    if (writeAnswerText && !hasEditorSemantic(snapshot) && !hasSubmitSemantic(snapshot)) {
      return {
        nextAction: "CLICK_WRITE_ANSWER",
        targetTexts: [writeAnswerText, "写回答", "编辑回答"],
        targetRoles: ["button", "link"],
        targetSelectors: [
          "button:has-text('编辑回答')",
          "button:has-text('写回答')",
          "button.WriteAnswerButton",
          ".QuestionHeaderActions button:has-text('编辑回答')",
          ".QuestionHeaderActions button:has-text('写回答')",
          ".QuestionHeaderActions button.WriteAnswerButton"
        ],
        confidence: "medium",
        reason: "页面仍是问题详情态，存在明确的“写回答”或“编辑回答”入口。"
      };
    }
  }

  if (hasEditorSemantic(snapshot) && (expectedActions.includes("FOCUS_EDITOR") || expectedActions.includes("PASTE_CONTENT"))) {
    return {
      nextAction: "FOCUS_EDITOR",
      targetTexts: [],
      targetRoles: [],
      targetSelectors: EDITOR_SELECTORS,
      confidence: "high",
      reason: "页面已进入回答编辑态，可直接聚焦编辑器并准备粘贴全文。"
    };
  }

  if (expectedActions.includes("CLICK_SUBMIT")) {
    const submitText = findFirstMatchingText(combinedTexts, ["发布回答", "提交回答", "发布"]);
    if (submitText && hasEditorSemantic(snapshot)) {
      return {
        nextAction: "CLICK_SUBMIT",
        targetTexts: [submitText],
        targetRoles: ["button", "link"],
        targetSelectors: [],
        confidence: "medium",
        reason: "页面已进入编辑态，并且出现了明确的发布入口。"
      };
    }
  }

  return null;
}

function coerceManualLoginPlan(
  snapshot: PageSnapshot,
  expectedActions: PublishStepAction[],
  plan: PublishStepPlan
): PublishStepPlan {
  if (plan.nextAction !== "REQUEST_MANUAL_LOGIN") {
    return plan;
  }

  if (hasExplicitManualLoginSignal(snapshot)) {
    return plan;
  }

  const fallbackPlan = buildFallbackPublishPlan(snapshot, expectedActions);
  if (fallbackPlan) {
    return {
      ...fallbackPlan,
      reason: `${fallbackPlan.reason} 已忽略一次缺少明确风控证据的人工登录判断。`
    };
  }

  if (hasLoggedInSurfaceSemantic(snapshot)) {
    return {
      nextAction: "WAIT",
      targetTexts: [],
      targetRoles: [],
      targetSelectors: [],
      confidence: "low",
      reason: "页面仍显示已登录内容，但没有明确挑战页证据，先不进入人工登录，等待并重试页面理解。"
    };
  }

  return plan;
}

function getExistingAnswerSignal(plan: PublishStepPlan): "view" | "edit" | null {
  if (plan.nextAction !== "VERIFY_RESULT") {
    return null;
  }

  const combined = [...plan.targetTexts, ...plan.targetSelectors].join(" ");
  if (combined.includes("查看我的回答") || combined.includes("我的回答")) {
    return "view";
  }

  return null;
}

function buildPublishContentSignals(content: string): PublishContentSignals {
  const trimmed = toZhihuDisplayText(content).trim();
  const paragraphs = trimmed
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const sentences = trimmed
    .split(/[。！？!?；;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const rawCandidates = [...paragraphs.slice(0, 3), ...sentences.slice(0, 6)];
  const expectedSignals = Array.from(
    new Set(
      rawCandidates
        .map((item) => normalizeComparableText(item))
        .filter((item) => item.length >= 18)
        .map((item) => item.slice(0, Math.min(item.length, 36)))
    )
  ).slice(0, 5);

  return {
    expectedExcerpt: trimmed.slice(0, 120),
    expectedSignals
  };
}

function buildZhihuRichTextPayload(content: string): ZhihuRichTextPayload {
  return {
    plainText: toZhihuDisplayText(content),
    html: renderZhihuHtml(content),
    boldSignals: buildExpectedBoldSignals(content)
  };
}

function toZhihuDisplayText(content: string) {
  return stripMarkdownBoldMarkers(content)
    .replace(/\r\n/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderZhihuHtml(content: string) {
  const blocks = content
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const html = blocks.map((block) => renderZhihuHtmlBlock(block)).join("");
  return `<meta charset="utf-8">${html}`;
}

function renderZhihuHtmlBlock(block: string) {
  const lines = block
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());

  if (lines.length === 0) {
    return "";
  }

  if (lines.length === 1) {
    const headingMatch = lines[0].match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(3, Math.max(2, headingMatch[1].length + 1));
      return `<h${level}>${renderInlineZhihuHtml(headingMatch[2])}</h${level}>`;
    }
  }

  if (lines.every((line) => /^\s{0,3}[-*+]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInlineZhihuHtml(line.replace(/^\s{0,3}[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
  }

  if (lines.every((line) => /^\s{0,3}\d+[.)]\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${renderInlineZhihuHtml(line.replace(/^\s{0,3}\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
  }

  return `<p>${lines.map((line) => renderInlineZhihuHtml(line)).join("<br>")}</p>`;
}

function renderInlineZhihuHtml(content: string) {
  return parseMarkdownBoldSegments(content)
    .map((segment) => {
      const escapedText = escapeHtml(segment.text);
      return segment.bold ? `<strong>${escapedText}</strong>` : escapedText;
    })
    .join("");
}

function buildExpectedBoldSignals(content: string) {
  return Array.from(
    new Set(
      parseMarkdownBoldSegments(content)
        .filter((segment) => segment.bold)
        .map((segment) => normalizeComparableText(segment.text))
        .filter((segment) => segment.length >= 12)
        .map((segment) => segment.slice(0, Math.min(segment.length, 36)))
    )
  );
}

function compareEditorRichFormatting(snapshot: PageSnapshot, boldSignals: string[]): EditorFormatComparison {
  if (boldSignals.length === 0) {
    return {
      decision: "NOT_REQUIRED",
      expectedBoldSignalCount: 0,
      matchedBoldSignals: [],
      reason: "正文没有需要加粗的重点片段。"
    };
  }

  const boldTextPool = normalizeComparableText((snapshot.editorBoldTexts ?? []).join(""));
  const matchedBoldSignals = boldSignals.filter((signal) => boldTextPool.includes(signal));

  if (matchedBoldSignals.length === boldSignals.length) {
    return {
      decision: "MATCHED",
      expectedBoldSignalCount: boldSignals.length,
      matchedBoldSignals,
      reason: `已命中 ${matchedBoldSignals.length}/${boldSignals.length} 个加粗片段。`
    };
  }

  return {
    decision: "MISMATCH",
    expectedBoldSignalCount: boldSignals.length,
    matchedBoldSignals,
    reason: `只命中 ${matchedBoldSignals.length}/${boldSignals.length} 个加粗片段，疑似知乎没有接受 HTML 富文本。`
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findMatchedExpectedSignals(snapshot: PageSnapshot, expectedSignals: string[]) {
  const snapshotTexts = [
    snapshot.title,
    ...snapshot.visibleTexts,
    ...snapshot.buttons,
    ...snapshot.links.map((item) => item.text)
  ]
    .map((item) => normalizeComparableText(item))
    .filter(Boolean);

  return expectedSignals.filter((signal) => snapshotTexts.some((text) => text.includes(signal)));
}

function mergeMatchedSignals(primary: string[], secondary: string[]) {
  return Array.from(new Set([...primary, ...secondary].filter(Boolean)));
}

function hasPublishedAnswerSemantic(snapshot: PageSnapshot) {
  const combined = [snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons, ...snapshot.links.map((item) => item.text)].join(" ");
  return ["回答已提交", "已发布", "发布成功"].some((text) => combined.includes(text));
}

function hasExplicitManualLoginSignal(snapshot: PageSnapshot) {
  const combined = [snapshot.url, snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons, ...snapshot.links.map((item) => item.text)]
    .join(" ")
    .toLowerCase();

  return (
    /zhihu\.com\/signin|zhihu\.com\/login|zhihu\.com\/account\/unhuman|captcha|challenge/i.test(snapshot.url) ||
    [
      "登录/注册",
      "注册/登录",
      "请先登录",
      "验证码登录",
      "手机号登录",
      "密码登录",
      "获取短信验证码",
      "安全验证",
      "异常验证",
      "验证身份",
      "请完成验证",
      "滑块验证",
      "拖动滑块",
      "人机验证",
      "访问受限",
      "风险验证",
      "账号存在异常",
      "反爬"
    ].some((text) => combined.includes(text.toLowerCase()))
  );
}

function hasLoggedInSurfaceSemantic(snapshot: PageSnapshot) {
  const combined = [snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons, ...snapshot.links.map((item) => item.text)].join(" ");

  return (
    /zhihu\.com\/settings\//i.test(snapshot.url) ||
    /zhihu\.com\/creator/i.test(snapshot.url) ||
    /zhihu\.com\/notifications/i.test(snapshot.url) ||
    ["账号设置", "登录方式", "绑定手机", "绑定邮箱", "创作中心", "发想法", "私信", "写回答", "查看我的回答", "编辑回答"].some(
      (text) => combined.includes(text)
    )
  );
}

function hasEditorSemantic(snapshot: PageSnapshot) {
  if (snapshot.editorContent !== null) {
    return true;
  }

  const combined = [snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons, ...snapshot.links.map((item) => item.text)].join(" ");
  return ["撤销", "重做", "清除格式", "标题", "加粗", "创作助手", "无声明", "允许规范转载", "任何人都可以评论"].some(
    (text) => combined.includes(text)
  );
}

function hasSubmitSemantic(snapshot: PageSnapshot) {
  const combined = [snapshot.title, ...snapshot.visibleTexts, ...snapshot.buttons, ...snapshot.links.map((item) => item.text)].join(" ");
  return SUBMIT_TEXT_CANDIDATES.some((text) => combined.includes(text));
}

function isAnswerDetailUrl(url: string) {
  return /\/answer\/\d+/i.test(url);
}

function findFirstMatchingText(values: string[], candidates: string[]) {
  for (const candidate of candidates) {
    const matched = values.find((value) => value.includes(candidate));
    if (matched) {
      return matched;
    }
  }

  return null;
}

function pickMyAnswerDetailUrl(snapshot: PageSnapshot, currentUrl: string) {
  const answerLinks = snapshot.links.filter(
    (item) => /\/question\/\d+\/answer\/\d+/i.test(item.href) && /(我的回答|查看我的回答|编辑回答)/.test(item.text)
  );
  if (answerLinks.length === 0) {
    return null;
  }

  try {
    return new URL(answerLinks[0].href, currentUrl).toString();
  } catch {
    return null;
  }
}

function normalizeComparableText(value: string) {
  return value.replace(/\s+/g, "").replace(/[.,，。！？!?；;:'\"“”‘’()（）[\]【】《》<>-]/g, "").trim();
}

function sanitizeSubmitTargets(targetTexts: string[]) {
  return targetTexts
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => !/发布于|发表于|^\d{4}-\d{2}-\d{2}/.test(item))
    .filter((item) => /发布回答|提交回答|发布/.test(item));
}

function compareExistingDraftToExpected(snapshot: PageSnapshot, expectedContent: string): ExistingDraftComparison {
  const expectedNormalized = normalizeComparableText(toZhihuDisplayText(expectedContent));
  const expectedLength = expectedNormalized.length;
  const expectedSignals = buildPublishContentSignals(expectedContent).expectedSignals;
  const editorCandidate = snapshot.editorContent === null ? null : normalizeComparableText(snapshot.editorContent);

  const candidateTexts =
    editorCandidate !== null
      ? [editorCandidate]
      : Array.from(
          new Set(
            [
              ...snapshot.visibleTexts,
              snapshot.visibleTexts.join(" "),
              snapshot.title,
              ...snapshot.links.map((item) => item.text)
            ]
              .map((item) => normalizeComparableText(item))
              .filter((item) => item.length >= 12)
          )
        );

  let bestText = "";
  let bestOverlapScore = 0;

  for (const candidate of candidateTexts) {
    const overlapScore = computeOverlapScore(expectedNormalized, candidate);
    if (overlapScore > bestOverlapScore) {
      bestOverlapScore = overlapScore;
      bestText = candidate;
    }
  }

  const actualLength = bestText.length;
  const lengthDelta = Math.abs(expectedLength - actualLength);
  const lengthDeltaRatio = expectedLength > 0 ? lengthDelta / expectedLength : 1;
  const matchedSignalCount = expectedSignals.filter((signal) => bestText.includes(signal)).length;

  if (
    bestText &&
    (bestText === expectedNormalized ||
      (bestOverlapScore >= 0.96 && lengthDeltaRatio <= 0.03) ||
      (bestOverlapScore >= 0.92 && lengthDelta <= 20))
  ) {
    return {
      decision: "MATCHED",
      expectedLength,
      actualLength,
      lengthDelta,
      lengthDeltaRatio,
      overlapScore: bestOverlapScore,
      matchedSignalCount,
      reason: `编辑器内容与待发布正文基本一致，长度差 ${lengthDelta} 字，重合度 ${(bestOverlapScore * 100).toFixed(1)}%。`
    };
  }

  if (
    bestText &&
    ((bestOverlapScore >= 0.78 && lengthDeltaRatio <= 0.2) ||
      (bestOverlapScore >= 0.7 && matchedSignalCount >= Math.min(2, Math.max(1, expectedSignals.length))))
  ) {
    return {
      decision: "SIMILAR",
      expectedLength,
      actualLength,
      lengthDelta,
      lengthDeltaRatio,
      overlapScore: bestOverlapScore,
      matchedSignalCount,
      reason: `编辑器内容与待发布正文接近，但还不能确认是同一版，长度差 ${lengthDelta} 字，重合度 ${(bestOverlapScore * 100).toFixed(1)}%。`
    };
  }

  return {
    decision: "MISMATCH",
    expectedLength,
    actualLength,
    lengthDelta,
    lengthDeltaRatio,
    overlapScore: bestOverlapScore,
    matchedSignalCount,
    reason: `编辑器内容与待发布正文差异较大，长度差 ${lengthDelta} 字，重合度 ${(bestOverlapScore * 100).toFixed(1)}%。`
  };
}

function parseMarkdownBoldSegments(content: string): AnswerTextSegment[] {
  const segments: AnswerTextSegment[] = [];
  const boldPattern = /\*\*([\s\S]*?)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = boldPattern.exec(content)) !== null) {
    const fullMatch = match[0] ?? "";
    const boldText = match[1] ?? "";

    if (match.index > cursor) {
      segments.push({
        text: content.slice(cursor, match.index),
        bold: false
      });
    }

    if (boldText.trim()) {
      segments.push({
        text: boldText,
        bold: true
      });
    } else {
      segments.push({
        text: fullMatch,
        bold: false
      });
    }

    cursor = match.index + fullMatch.length;
  }

  if (cursor < content.length) {
    segments.push({
      text: content.slice(cursor),
      bold: false
    });
  }

  return mergeAdjacentAnswerSegments(segments.length ? segments : [{ text: content, bold: false }]);
}

function stripMarkdownBoldMarkers(content: string) {
  return parseMarkdownBoldSegments(content)
    .map((segment) => segment.text)
    .join("");
}

function mergeAdjacentAnswerSegments(segments: AnswerTextSegment[]) {
  const merged: AnswerTextSegment[] = [];

  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && last.bold === segment.bold) {
      last.text += segment.text;
      continue;
    }

    merged.push({ ...segment });
  }

  return merged;
}

function computeOverlapScore(expected: string, actual: string) {
  if (!expected || !actual) {
    return 0;
  }

  const minGram = 12;
  if (expected.length < minGram || actual.length < minGram) {
    return expected === actual ? 1 : 0;
  }

  const grams = new Set<string>();
  for (let index = 0; index <= expected.length - minGram; index += 1) {
    grams.add(expected.slice(index, index + minGram));
  }

  if (grams.size === 0) {
    return 0;
  }

  let matched = 0;
  for (const gram of grams) {
    if (actual.includes(gram)) {
      matched += 1;
    }
  }

  return matched / grams.size;
}
