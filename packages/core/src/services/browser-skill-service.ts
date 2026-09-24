import { randomUUID } from "node:crypto";
import type { SkillName } from "@zhihu-mvp/shared";
import { JobRepository } from "../repositories/job-repository.js";
import type { PageSnapshot, RuntimeTraceContext } from "./playwright-tool-runtime.js";
import { PlaywrightToolRuntime } from "./playwright-tool-runtime.js";

type ClickInput = {
  names?: string[];
  roles?: Array<"button" | "link">;
  selectors?: string[];
  exact?: boolean;
};

type FocusInput = {
  selectors: string[];
};

type TypeInput = {
  text: string;
  delay?: number;
};

type RichTextInput = {
  text: string;
  html: string;
};

type PressInput = {
  key: string;
};

type OpenInput = {
  url: string;
};

type WaitInput = {
  ms: number;
};

type ScrollInput = {
  direction?: "top" | "bottom";
  amount?: number;
};

type ScreenshotInput = {
  label: string;
};

export type BrowserSkillContext = RuntimeTraceContext & {
  agentName: string;
};

export class BrowserSkillService {
  private readonly skillName: SkillName = "browser-playwright";

  constructor(
    private readonly runtime: PlaywrightToolRuntime,
    private readonly jobRepository: JobRepository
  ) {}

  async open(context: BrowserSkillContext, input: OpenInput) {
    return this.runSkill(context, "open", input, () => this.runtime.open(context, input));
  }

  async snapshot(context: BrowserSkillContext) {
    return this.runSkill(context, "snapshot", {}, () => this.runtime.snapshot(context));
  }

  async click(context: BrowserSkillContext, input: ClickInput) {
    return this.runSkill(context, "click", input, () => this.runtime.click(context, input));
  }

  async focus(context: BrowserSkillContext, input: FocusInput) {
    return this.runSkill(context, "focus", input, () => this.runtime.focus(context, input));
  }

  async pasteText(context: BrowserSkillContext, input: TypeInput) {
    return this.runSkill(context, "paste_text", { length: input.text.length }, () => this.runtime.pasteText(context, input));
  }

  async pasteRichText(context: BrowserSkillContext, input: RichTextInput) {
    return this.runSkill(context, "paste_rich_text", { textLength: input.text.length, htmlLength: input.html.length }, () =>
      this.runtime.pasteRichText(context, input)
    );
  }

  async type(context: BrowserSkillContext, input: TypeInput) {
    return this.runSkill(context, "type", { length: input.text.length, delay: input.delay ?? 0 }, () => this.runtime.type(context, input));
  }

  async press(context: BrowserSkillContext, input: PressInput) {
    return this.runSkill(context, "press", input, () => this.runtime.press(context, input));
  }

  async wait(context: BrowserSkillContext, input: WaitInput) {
    return this.runSkill(context, "wait", input, () => this.runtime.wait(context, input));
  }

  async scroll(context: BrowserSkillContext, input: ScrollInput = {}) {
    return this.runSkill(context, "scroll", input, () => this.runtime.scroll(context, input));
  }

  async reload(context: BrowserSkillContext) {
    return this.runSkill(context, "reload", {}, () => this.runtime.reload(context));
  }

  async getUrl(context: BrowserSkillContext) {
    return this.runSkill(context, "get_url", {}, () => this.runtime.getUrl(context));
  }

  async screenshot(context: BrowserSkillContext, input: ScreenshotInput) {
    return this.runSkill(context, "screenshot", input, () => this.runtime.screenshot(context, input));
  }

  async closeSession(sessionKey: string) {
    await this.runtime.closeSession(sessionKey);
  }

  scheduleSessionClose(sessionKey: string, delayMs: number) {
    this.runtime.scheduleSessionClose(sessionKey, delayMs);
  }

  async closeAllSessions() {
    await this.runtime.closeAllSessions();
  }

  hasSession(sessionKey: string) {
    return this.runtime.hasSession(sessionKey);
  }

  async restartSession(traceContext: RuntimeTraceContext) {
    await this.runtime.restartSession(traceContext);
  }

  private async runSkill<T>(
    context: BrowserSkillContext,
    inputAction: string,
    input: Record<string, unknown>,
    operation: () => Promise<T>
  ) {
    const startedAt = Date.now();
    const traceId = `${context.traceGroupId ?? randomUUID()}:skill:${inputAction}:${Date.now()}`;

    try {
      const output = await operation();
      await this.jobRepository.createSkillRun({
        publishJobId: context.publishJobId ?? null,
        publishAttemptId: context.publishAttemptId ?? null,
        skillName: this.skillName,
        agentName: context.agentName,
        stage: context.stage ?? null,
        traceId,
        inputJson: JSON.stringify({
          action: inputAction,
          input
        }),
        outputJson: JSON.stringify(output),
        durationMs: Date.now() - startedAt,
        success: true
      });
      return output;
    } catch (error) {
      await this.jobRepository.createSkillRun({
        publishJobId: context.publishJobId ?? null,
        publishAttemptId: context.publishAttemptId ?? null,
        skillName: this.skillName,
        agentName: context.agentName,
        stage: context.stage ?? null,
        traceId,
        inputJson: JSON.stringify({
          action: inputAction,
          input
        }),
        outputJson: null,
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: error instanceof Error ? error.message : "Unknown browser skill error"
      });
      throw error;
    }
  }
}

export type { PageSnapshot };
