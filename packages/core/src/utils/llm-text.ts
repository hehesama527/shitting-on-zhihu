import type { OpenAI } from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { LlmRuntimeConfig } from "../config/llm-provider.js";

export type LlmTextMessage = {
  role: "system" | "user";
  content: string;
};

export type LlmTextRequestOptions = {
  initialResponseTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
};

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;
const STREAM_FALLBACK_HINT = /(stream|sse|event-stream|unsupported|not support|invalid parameter|unknown parameter)/i;
const MAX_RETRIES = 3;
const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function createLlmTextResponse(
  client: OpenAI,
  runtime: LlmRuntimeConfig,
  messages: LlmTextMessage[],
  options?: LlmTextRequestOptions
): Promise<unknown> {
  return withRetry("createLlmTextResponse", async () => {
    const initialResponseTimeoutMs = normalizeTimeout(options?.initialResponseTimeoutMs, 120_000);
    const streamIdleTimeoutMs = normalizeTimeout(options?.streamIdleTimeoutMs, DEFAULT_STREAM_IDLE_TIMEOUT_MS);

    if (runtime.wireApi === "chat_completions") {
      try {
        return await createStreamingChatCompletionText(client, runtime, messages, {
          initialResponseTimeoutMs,
          streamIdleTimeoutMs
        });
      } catch (error) {
        if (!shouldFallbackToNonStreaming(error)) {
          throw error;
        }

        // 有些中转渠道只代理了流式接口，非流式请求会一直挂起不返回、也不报错。
        // openai SDK 自带的 timeout 选项在这类渠道上并不总是生效，这里用一个独立的
        // Promise.race 兜底，保证即便渠道真的"卡住不返回"，也能在有限时间内报错重试，
        // 而不是无限期挂起整个 worker tick。
        return raceWithTimeout(
          client.chat.completions.create(
            {
              model: runtime.model,
              messages
            },
            {
              timeout: runtime.requestTimeoutMs
            }
          ),
          initialResponseTimeoutMs,
          `LLM non-streaming fallback timeout after ${initialResponseTimeoutMs}ms (channel may not support non-streaming requests).`
        );
      }
    }

    try {
      return await createStreamingResponsesText(client, runtime, messages, {
        initialResponseTimeoutMs,
        streamIdleTimeoutMs
      });
    } catch (error) {
      if (!shouldFallbackToNonStreaming(error)) {
        throw error;
      }

      return raceWithTimeout(
        client.responses.create(
          {
            model: runtime.model,
            reasoning: { effort: runtime.reasoningEffort },
            input: messages
          },
          {
            timeout: runtime.requestTimeoutMs
          }
        ),
        initialResponseTimeoutMs,
        `LLM non-streaming fallback timeout after ${initialResponseTimeoutMs}ms (channel may not support non-streaming requests).`
      );
    }
  });
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function createStreamingChatCompletionText(
  client: OpenAI,
  runtime: LlmRuntimeConfig,
  messages: LlmTextMessage[],
  options: Required<LlmTextRequestOptions>
) {
  const controller = new AbortController();
  const stream = await client.chat.completions.create(
    {
      model: runtime.model,
      messages,
      stream: true
    },
    {
      signal: controller.signal,
      timeout: runtime.requestTimeoutMs
    }
  );

  const iterator = stream[Symbol.asyncIterator]();
  let sawChunk = false;
  let text = "";

  while (true) {
    const chunk = await readNextStreamValue(iterator, controller, {
      timeoutMs: sawChunk ? options.streamIdleTimeoutMs : options.initialResponseTimeoutMs,
      message: sawChunk
        ? `LLM stream idle for ${sawChunk ? options.streamIdleTimeoutMs : options.initialResponseTimeoutMs}ms`
        : `LLM did not return the first stream chunk within ${options.initialResponseTimeoutMs}ms`
    });

    if (chunk.done) {
      break;
    }

    sawChunk = true;
    text += extractChatCompletionChunkText(chunk.value);
  }

  if (!sawChunk) {
    throw new Error("LLM returned an empty stream.");
  }

  return text;
}

async function createStreamingResponsesText(
  client: OpenAI,
  runtime: LlmRuntimeConfig,
  messages: LlmTextMessage[],
  options: Required<LlmTextRequestOptions>
) {
  const controller = new AbortController();
  const stream = await client.responses.create(
    {
      model: runtime.model,
      reasoning: { effort: runtime.reasoningEffort },
      input: messages,
      stream: true
    },
    {
      signal: controller.signal,
      timeout: runtime.requestTimeoutMs
    }
  );

  const iterator = stream[Symbol.asyncIterator]();
  let sawChunk = false;
  let sawTextDelta = false;
  let text = "";

  while (true) {
    const event = await readNextStreamValue(iterator, controller, {
      timeoutMs: sawChunk ? options.streamIdleTimeoutMs : options.initialResponseTimeoutMs,
      message: sawChunk
        ? `LLM stream idle for ${sawChunk ? options.streamIdleTimeoutMs : options.initialResponseTimeoutMs}ms`
        : `LLM did not return the first stream chunk within ${options.initialResponseTimeoutMs}ms`
    });

    if (event.done) {
      break;
    }

    sawChunk = true;
    const extracted = extractResponsesStreamEventText(event.value, sawTextDelta);
    if (extracted.kind === "delta") {
      sawTextDelta = true;
      text += extracted.text;
    } else if (extracted.kind === "final" && !sawTextDelta) {
      text = extracted.text;
    }
  }

  if (!sawChunk) {
    throw new Error("LLM returned an empty stream.");
  }

  return text;
}

async function readNextStreamValue<T>(
  iterator: AsyncIterator<T>,
  controller: AbortController,
  input: { timeoutMs: number; message: string }
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(input.message);
          reject(new Error(input.message));
        }, input.timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function extractChatCompletionChunkText(chunk: ChatCompletionChunk) {
  return chunk.choices
    .map((choice) => choice.delta?.content ?? choice.delta?.refusal ?? "")
    .filter(Boolean)
    .join("");
}

function extractResponsesStreamEventText(event: ResponseStreamEvent, hasDeltaText: boolean) {
  if (event.type === "response.output_text.delta") {
    return {
      kind: "delta" as const,
      text: event.delta
    };
  }

  if (event.type === "response.refusal.delta") {
    return {
      kind: "delta" as const,
      text: event.delta
    };
  }

  if (event.type === "response.output_text.done" && !hasDeltaText) {
    return {
      kind: "final" as const,
      text: event.text
    };
  }

  if (event.type === "response.refusal.done" && !hasDeltaText) {
    return {
      kind: "final" as const,
      text: event.refusal
    };
  }

  return {
    kind: "none" as const,
    text: ""
  };
}

function shouldFallbackToNonStreaming(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const status = typeof (error as { status?: unknown }).status === "number" ? Number((error as { status?: unknown }).status) : null;
  const message = error.message ?? "";

  return (status === 400 || status === 404 || status === 405 || status === 422 || status === 501) && STREAM_FALLBACK_HINT.test(message);
}

function normalizeTimeout(value: number | undefined, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  return fallback;
}

async function withRetry<T>(scope: string, request: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const diagnostics = extractErrorDiagnostics(error);
      const shouldRetry = attempt < MAX_RETRIES && isRetryableError(diagnostics);

      console.error("[llm] request failed", {
        scope,
        attempt: attempt + 1,
        maxAttempts: MAX_RETRIES + 1,
        shouldRetry,
        category: classifyFailure(diagnostics),
        ...diagnostics
      });

      if (!shouldRetry) {
        throw toDiagnosticError(error, diagnostics);
      }

      await sleep(computeBackoffMs(attempt));
    }
  }

  throw new Error("LLM request failed after retries.");
}

function isRetryableError(input: ReturnType<typeof extractErrorDiagnostics>) {
  if (input.status && RETRYABLE_HTTP_STATUS.has(input.status)) {
    return true;
  }

  if (input.code && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "upstream_stream_read_error", "stream_read_error"].includes(input.code)) {
    return true;
  }

  const text = `${input.message} ${input.causeMessage}`.toLowerCase();
  return (
    text.includes("connection error") ||
    text.includes("fetch failed") ||
    text.includes("timeout") ||
    text.includes("network") ||
    text.includes("temporarily unavailable") ||
    text.includes("stream was interrupted") ||
    text.includes("stream_read_error")
  );
}

function computeBackoffMs(attempt: number) {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toDiagnosticError(error: unknown, diagnostics: ReturnType<typeof extractErrorDiagnostics>) {
  const category = classifyFailure(diagnostics);
  const parts = [
    `${category}`,
    diagnostics.code ? `code=${diagnostics.code}` : null,
    diagnostics.status ? `status=${diagnostics.status}` : null,
    diagnostics.syscall ? `syscall=${diagnostics.syscall}` : null,
    diagnostics.hostname ? `hostname=${diagnostics.hostname}` : null,
    diagnostics.message ? `message=${diagnostics.message}` : null,
    diagnostics.causeMessage ? `cause=${diagnostics.causeMessage}` : null
  ].filter(Boolean);

  const wrapped = new Error(`LLM request failed: ${parts.join(" | ")}`);
  (wrapped as { cause?: unknown }).cause = error;
  return wrapped;
}

function classifyFailure(input: ReturnType<typeof extractErrorDiagnostics>) {
  const msg = `${input.message} ${input.causeMessage}`.toLowerCase();

  if (input.status === 429 || msg.includes("rate limit")) {
    return "rate_limit";
  }
  if (input.code === "ENOTFOUND" || input.code === "EAI_AGAIN" || msg.includes("getaddrinfo")) {
    return "dns_error";
  }
  if (input.code === "ECONNREFUSED" && (input.hostname === "127.0.0.1" || input.hostname === "localhost")) {
    return "proxy_refused";
  }
  if (msg.includes("certificate") || msg.includes("tls") || msg.includes("ssl")) {
    return "tls_error";
  }
  if (msg.includes("timeout") || input.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (msg.includes("connection error") || msg.includes("fetch failed") || msg.includes("network")) {
    return "network_error";
  }

  return "unknown_error";
}

function extractErrorDiagnostics(error: unknown) {
  const normalized = asRecord(error);
  const cause = asRecord(normalized?.cause);

  const status = readNumber(normalized, "status");
  const message = readString(normalized, "message") ?? String(error);
  const code =
    readString(normalized, "code") ??
    readString(cause, "code") ??
    readString(normalized, "errno") ??
    readString(cause, "errno");

  return {
    name: readString(normalized, "name"),
    message,
    status,
    code,
    syscall: readString(normalized, "syscall") ?? readString(cause, "syscall"),
    hostname: readString(normalized, "hostname") ?? readString(cause, "hostname"),
    causeMessage: readString(cause, "message") ?? null
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(input: Record<string, unknown> | null, key: string) {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(input: Record<string, unknown> | null, key: string) {
  const value = input?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
