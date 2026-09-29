import type { PromptSetName, PromptSnapshotMap } from "@zhihu-mvp/shared";
import { createOpenAiClient, readLlmRuntimeConfig, resolveLlmQuotaFallbacks } from "../config/llm-provider.js";
import { getDefaultPromptSeed } from "../prompts/default-prompts.js";
import { PromptRepository } from "../repositories/prompt-repository.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { extractResponseText, safeParseJson } from "../utils/json.js";
import { createLlmTextResponse } from "../utils/llm-text.js";

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;
const WRITER_LLM_REQUEST_TIMEOUT_MS = 600_000;

export const ALL_PROMPT_SET_NAMES: PromptSetName[] = [
  "topic_agent",
  "writer_agent",
  "review_agent",
  "publish_agent"
];

type PromptRunOptions = {
  promptSnapshot?: PromptSnapshotMap | null;
  promptSuffix?: string | null;
};

type PromptSnapshotBindingOptions = {
  names?: PromptSetName[];
  writerPromptVersionId?: number | null;
};

export class LlmService {
  constructor(private readonly promptRepository: PromptRepository) {}

  async getActivePromptSnapshot(names = ALL_PROMPT_SET_NAMES) {
    const activeSnapshots = await this.promptRepository.getActivePromptSnapshots(names);

    for (const name of names) {
      if (!activeSnapshots[name]) {
        const seed = getDefaultPromptSeed(name);
        if (!seed) {
          continue;
        }
        activeSnapshots[name] = {
          promptSetName: name,
          promptVersionId: null,
          version: null,
          label: seed.label,
          content: seed.content
        };
      }
    }

    return activeSnapshots;
  }

  async getPromptSnapshotForAccount(options?: PromptSnapshotBindingOptions) {
    const names = options?.names ?? ALL_PROMPT_SET_NAMES;
    const activeSnapshots = await this.getActivePromptSnapshot(names);
    const writerPromptVersionId = options?.writerPromptVersionId ?? null;

    if (!writerPromptVersionId || !names.includes("writer_agent")) {
      return activeSnapshots;
    }

    const writerSnapshot = await this.promptRepository.getPromptVersionSnapshotById(writerPromptVersionId);
    if (writerSnapshot?.promptSetName === "writer_agent") {
      activeSnapshots.writer_agent = writerSnapshot;
    }

    return activeSnapshots;
  }

  async resolvePrompt(promptSetName: PromptSetName, options?: PromptRunOptions) {
    const snapshotPrompt = options?.promptSnapshot?.[promptSetName];
    const basePrompt =
      snapshotPrompt?.content ??
      (await this.promptRepository.getActivePromptContent(promptSetName)) ??
      getDefaultPromptSeed(promptSetName)?.content ??
      "";

    const promptSuffix = options?.promptSuffix?.trim();
    if (promptSuffix) {
      return `${basePrompt}\n\n${promptSuffix}`;
    }

    return basePrompt;
  }

  async runPrompt(promptSetName: PromptSetName, input: unknown, options?: PromptRunOptions) {
    const startedAt = Date.now();
    const prompt = await this.resolvePrompt(promptSetName, options);
    const timeoutMs = getPromptTimeoutMs(promptSetName);
    logDebugTiming("llm.runPrompt", "start", {
      promptSetName,
      timeoutMs
    });

    try {
      const responseText = await this.runSystemPrompt(
        prompt,
        input,
        timeoutMs,
        `${promptSetName} returned empty response text.`,
        promptSetName
      );
      logDebugTiming("llm.runPrompt", "done", {
        promptSetName,
        timeoutMs,
        elapsedMs: getElapsedMs(startedAt),
        outputLength: responseText.length
      });
      return responseText;
    } catch (error) {
      const diagnostics = extractErrorDiagnostics(error);
      logDebugTiming("llm.runPrompt", "failed", {
        promptSetName,
        timeoutMs,
        elapsedMs: getElapsedMs(startedAt),
        error: diagnostics.message,
        errorCause: diagnostics.causeMessage,
        errorCode: diagnostics.code,
        errorSyscall: diagnostics.syscall,
        errorHostname: diagnostics.hostname
      });
      throw error;
    }
  }

  async runJson<T>(promptSetName: PromptSetName, input: unknown, fallback: T, options?: PromptRunOptions) {
    const responseText = await this.runPrompt(promptSetName, input, options);
    return safeParseJson(responseText, fallback);
  }

  async runSystemPrompt(
    systemPrompt: string,
    input: unknown,
    timeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    emptyMessage?: string,
    runtimeTarget: PromptSetName | "zhihu" = "zhihu"
  ) {
    const client = createOpenAiClient(runtimeTarget);
    const runtime = readLlmRuntimeConfig(runtimeTarget);

    const response = await createLlmTextResponse(
      client,
      runtime,
      [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
      ],
      {
        initialResponseTimeoutMs: timeoutMs,
        quotaFallbacks: resolveLlmQuotaFallbacks(runtimeTarget)
      }
    );

    const outputText = extractResponseText(response);
    if (!outputText.trim()) {
      throw new Error(emptyMessage ?? "custom system prompt returned empty response text.");
    }

    return outputText.trim();
  }

  async runJsonWithSystemPrompt<T>(
    systemPrompt: string,
    input: unknown,
    fallback: T,
    timeoutMs = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    runtimeTarget: PromptSetName | "zhihu" = "zhihu"
  ) {
    const startedAt = Date.now();
    logDebugTiming("llm.runJsonWithSystemPrompt", "start", {
      timeoutMs
    });

    try {
      const responseText = await this.runSystemPrompt(
        systemPrompt,
        input,
        timeoutMs,
        "custom system prompt returned empty response text.",
        runtimeTarget
      );
      logDebugTiming("llm.runJsonWithSystemPrompt", "done", {
        timeoutMs,
        elapsedMs: getElapsedMs(startedAt),
        outputLength: responseText.length
      });
      return safeParseJson(responseText, fallback);
    } catch (error) {
      const diagnostics = extractErrorDiagnostics(error);
      logDebugTiming("llm.runJsonWithSystemPrompt", "failed", {
        timeoutMs,
        elapsedMs: getElapsedMs(startedAt),
        error: diagnostics.message,
        errorCause: diagnostics.causeMessage,
        errorCode: diagnostics.code,
        errorSyscall: diagnostics.syscall,
        errorHostname: diagnostics.hostname
      });
      throw error;
    }
  }
}

function getPromptTimeoutMs(promptSetName: PromptSetName) {
  if (promptSetName === "writer_agent" || promptSetName === "zhihu_note_agent") {
    return WRITER_LLM_REQUEST_TIMEOUT_MS;
  }

  return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

function extractErrorDiagnostics(error: unknown) {
  const obj = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const cause = obj?.cause && typeof obj.cause === "object" ? (obj.cause as Record<string, unknown>) : null;

  return {
    message: error instanceof Error ? error.message : String(error),
    causeMessage: typeof cause?.message === "string" ? cause.message : null,
    code: pickString(obj, cause, "code"),
    syscall: pickString(obj, cause, "syscall"),
    hostname: pickString(obj, cause, "hostname")
  };
}

function pickString(primary: Record<string, unknown> | null, secondary: Record<string, unknown> | null, key: string) {
  const first = primary?.[key];
  if (typeof first === "string" && first.trim()) {
    return first.trim();
  }

  const second = secondary?.[key];
  if (typeof second === "string" && second.trim()) {
    return second.trim();
  }

  return null;
}
