import type { PublishStepPlan } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import { logDebugTiming } from "../utils/debug-timing.js";
import type { PageSnapshot } from "./playwright-tool-runtime.js";

export type LayaSessionSnapshotInput = {
  url: string;
  title: string;
  visibleTexts: string[];
  buttons?: string[];
  links?: Array<{ text: string; href: string }>;
};

export type LayaSessionDetectionResult = {
  session_state: "active" | "login_required" | "session_expired" | "unknown";
  reason: string;
  confidence: "high" | "medium" | "low";
};

export type LayaReviewPublishInput = {
  currentUrl: string;
  title?: string;
  matchedSignals?: string[];
  editorStillVisible?: boolean;
  visibleTexts?: string[];
  expectedExcerpt?: string;
};

export type LayaPublishResultReview = {
  decision: "SUCCESS" | "CONTENT_RISK" | "UNCERTAIN";
  confidence: "high" | "medium" | "low";
  matchedSignals: string[];
  reason: string;
};

export type LayaPublishFailureInput = {
  currentUrl: string;
  title?: string;
  buttons?: string[];
  visibleTexts?: string[];
  editorStillVisible?: boolean;
  lastAction?: string;
  lastError?: string;
};

export type LayaPublishFailureClassification = {
  failureType:
    | "ELEMENT_NOT_FOUND"
    | "EDITOR_NOT_READY"
    | "SUBMIT_DISABLED"
    | "LOGIN_REQUIRED"
    | "CAPTCHA_REQUIRED"
    | "RISK_CONTROL"
    | "NETWORK_TIMEOUT"
    | "PAGE_LAYOUT_CHANGED"
    | "PUBLISH_UNCERTAIN"
    | "UNKNOWN";
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type LayaTopicClassification = {
  relevant: boolean;
  topicType: string;
  valueLevel: "high" | "medium" | "low";
  riskLevel: "high" | "medium" | "low";
  duplicateRisk: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  reason?: string;
};

export type LayaDraftPrecheck = {
  decision: "PASS" | "REVIEW" | "BLOCK";
  riskFlags: Array<{ type: string; text: string; reason: string }>;
  formatIssues: string[];
  duplicateSignals: string[];
  confidence: "high" | "medium" | "low";
};

export type LayaHumanizerMark = {
  segments: Array<{ start: number; end: number; issue: string; suggestion: string }>;
  confidence: "high" | "medium" | "low";
};

export type LayaRetryDecision = {
  action: "retry" | "refresh" | "reopen" | "manual_login" | "stop";
  waitMs: number;
  reason: string;
  confidence: "high" | "medium" | "low";
};

export class LayaService {
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor(baseUrl?: string | null, enabled?: boolean) {
    const config = getAppConfig();
    this.baseUrl = baseUrl ?? config.layaApiUrl ?? "http://127.0.0.1:8100";
    this.enabled = enabled ?? config.layaEnabled;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.enabled) {
      return false;
    }
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async detectSessionState(input: LayaSessionSnapshotInput): Promise<LayaSessionDetectionResult | null> {
    if (!this.enabled) {
      return null;
    }

    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/detect-session-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: input.url,
          title: input.title,
          visibleTexts: input.visibleTexts,
          buttons: input.buttons ?? [],
          links: input.links ?? []
        }),
        signal: AbortSignal.timeout(1500)
      });

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as LayaSessionDetectionResult;
      logDebugTiming("laya.detectSessionState", "done", {
        elapsedMs: Date.now() - start,
        session_state: data.session_state
      });
      return data;
    } catch (err) {
      logDebugTiming("laya.detectSessionState", "fallback_to_llm", {
        elapsedMs: Date.now() - start,
        error: String(err)
      });
      return null;
    }
  }

  async understandPublishPage(snapshot: PageSnapshot): Promise<PublishStepPlan | null> {
    if (!this.enabled) {
      return null;
    }

    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/understand-publish-page`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: snapshot.url,
          title: snapshot.title,
          buttons: snapshot.buttons ?? [],
          links: snapshot.links ?? [],
          visibleTexts: snapshot.visibleTexts ?? []
        }),
        signal: AbortSignal.timeout(1500)
      });

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as {
        nextAction: PublishStepPlan["nextAction"];
        targetTexts: string[];
        targetRoles: ("button" | "link")[];
        confidence: "high" | "medium" | "low";
        reason: string;
      };

      logDebugTiming("laya.understandPublishPage", "done", {
        elapsedMs: Date.now() - start,
        nextAction: data.nextAction
      });

      return {
        nextAction: data.nextAction,
        targetTexts: data.targetTexts ?? [],
        targetRoles: data.targetRoles ?? [],
        targetSelectors: [],
        confidence: data.confidence ?? "medium",
        reason: data.reason ?? "Laya毫秒决策"
      };
    } catch (err) {
      logDebugTiming("laya.understandPublishPage", "fallback_to_llm", {
        elapsedMs: Date.now() - start,
        error: String(err)
      });
      return null;
    }
  }

  async reviewPublishResult(input: LayaReviewPublishInput): Promise<LayaPublishResultReview | null> {
    if (!this.enabled) {
      return null;
    }

    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/review-publish-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentUrl: input.currentUrl,
          title: input.title ?? "",
          matchedSignals: input.matchedSignals ?? [],
          editorStillVisible: input.editorStillVisible ?? false,
          visibleTexts: input.visibleTexts ?? [],
          expectedExcerpt: input.expectedExcerpt ?? ""
        }),
        signal: AbortSignal.timeout(1500)
      });

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as LayaPublishResultReview;
      logDebugTiming("laya.reviewPublishResult", "done", {
        elapsedMs: Date.now() - start,
        decision: data.decision
      });
      return data;
    } catch (err) {
      logDebugTiming("laya.reviewPublishResult", "fallback_to_llm", {
        elapsedMs: Date.now() - start,
        error: String(err)
      });
      return null;
    }
  }

  async classifyPublishFailure(input: LayaPublishFailureInput): Promise<LayaPublishFailureClassification | null> {
    if (!this.enabled) return null;
    const start = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/api/classify-publish-failure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(1200)
      });
      if (!res.ok) return null;
      const data = (await res.json()) as LayaPublishFailureClassification;
      logDebugTiming("laya.classifyPublishFailure", "done", { elapsedMs: Date.now() - start, failureType: data.failureType });
      return data;
    } catch (err) {
      logDebugTiming("laya.classifyPublishFailure", "fallback", { elapsedMs: Date.now() - start, error: String(err) });
      return null;
    }
  }

  private async post<T>(path: string, input: unknown, timeoutMs = 1500): Promise<T | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs)
      });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async classifyTopic(input: { title: string; url?: string; sourceType?: string; historyMatched?: boolean }): Promise<LayaTopicClassification | null> {
    return this.post<LayaTopicClassification>("/api/classify-topic", input, 1200);
  }

  async precheckDraft(input: { title?: string; content: string; topicSummary?: string }): Promise<LayaDraftPrecheck | null> {
    return this.post<LayaDraftPrecheck>("/api/precheck-draft", input, 1800);
  }

  async markHumanizer(input: { content: string }): Promise<LayaHumanizerMark | null> {
    return this.post<LayaHumanizerMark>("/api/humanizer-mark", input, 1800);
  }

  async decideRetry(input: { failureType: string; retryCount: number; stage?: string; context?: unknown }): Promise<LayaRetryDecision | null> {
    return this.post<LayaRetryDecision>("/api/retry-decision", input, 1200);
  }
}
