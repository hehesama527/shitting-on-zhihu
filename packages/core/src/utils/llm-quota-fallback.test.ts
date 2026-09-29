import assert from "node:assert/strict";
import test from "node:test";
import { isVolcanoRuntime, resolveLlmQuotaFallbacks } from "../config/llm-provider.js";
import { createLlmTextResponse, isAccountQuotaExceeded, isRateLimitError } from "./llm-text.js";

test("volcano runtime is detected by host or doubao model", () => {
  assert.equal(isVolcanoRuntime({ baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", model: "doubao-seed-2.1-turbo" }), true);
  assert.equal(isVolcanoRuntime({ baseUrl: "https://api.dududu.cloud/v1", model: "gpt-6-sol" }), false);
});

test("only writer_agent gets the Zhihu Dudu quota fallback", () => {
  const writerFallbacks = resolveLlmQuotaFallbacks("writer_agent");
  const topicFallbacks = resolveLlmQuotaFallbacks("topic_agent");
  const reviewFallbacks = resolveLlmQuotaFallbacks("review_agent");
  const publishFallbacks = resolveLlmQuotaFallbacks("publish_agent");

  assert.equal(writerFallbacks.length, 1);
  assert.match(writerFallbacks[0].runtime.baseUrl, /dududu\.cloud/i);
  assert.equal(topicFallbacks.length, 0);
  assert.equal(reviewFallbacks.length, 0);
  assert.equal(publishFallbacks.length, 0);
});

test("account quota errors are recognized and ordinary rate limits are not", () => {
  const quota = Object.assign(new Error("429 You have exceeded the weekly usage quota"), {
    status: 429,
    code: "AccountQuotaExceeded"
  });
  assert.equal(isAccountQuotaExceeded(quota), true);
  assert.equal(isAccountQuotaExceeded(Object.assign(new Error("Too many requests"), { status: 429, code: "rate_limit_exceeded" })), false);
});

test("a configured backup API is tried immediately after a primary 429", async () => {
  let primaryCalls = 0;
  let backupCalls = 0;

  const primary = {
    chat: {
      completions: {
        create: async () => {
          primaryCalls += 1;
          throw Object.assign(new Error("429 Too Many Requests"), {
            status: 429,
            code: "rate_limit_exceeded"
          });
        }
      }
    }
  };
  const backup = {
    chat: {
      completions: {
        create: async () => {
          backupCalls += 1;
          return (async function* () {
            yield {
              choices: [{ delta: { content: "backup-ok" } }]
            };
          })();
        }
      }
    }
  };

  const result = await createLlmTextResponse(
    primary as never,
    {
      model: "primary",
      baseUrl: "https://primary.invalid/v1",
      apiKey: "primary-key",
      proxyUrl: null,
      wireApi: "chat_completions",
      reasoningEffort: "high",
      requestTimeoutMs: 1000
    },
    [{ role: "user", content: "ping" }],
    {
      quotaFallbacks: [
        {
          client: backup as never,
          runtime: {
            model: "backup",
            baseUrl: "https://backup.invalid/v1",
            apiKey: "backup-key",
            proxyUrl: null,
            wireApi: "chat_completions",
            reasoningEffort: "high",
            requestTimeoutMs: 1000
          }
        }
      ]
    }
  );

  assert.equal(result, "backup-ok");
  assert.equal(primaryCalls, 1);
  assert.equal(backupCalls, 1);
  assert.equal(isRateLimitError(Object.assign(new Error("429"), { status: 429 })), true);
});

test("a failed backup keeps its status for the next backup decision", async () => {
  let secondBackupCalls = 0;
  const primary = {
    chat: {
      completions: {
        create: async () => {
          throw Object.assign(new Error("429 Too Many Requests"), {
            status: 429,
            code: "rate_limit_exceeded"
          });
        }
      }
    }
  };
  const unauthorizedBackup = {
    chat: {
      completions: {
        create: async () => {
          throw Object.assign(new Error("invalid access token"), {
            status: 401,
            code: "invalid_api_key"
          });
        }
      }
    }
  };
  const secondBackup = {
    chat: {
      completions: {
        create: async () => {
          secondBackupCalls += 1;
          return (async function* () {
            yield {
              choices: [{ delta: { content: "second-backup-ok" } }]
            };
          })();
        }
      }
    }
  };

  const baseRuntime = {
    proxyUrl: null,
    wireApi: "chat_completions" as const,
    reasoningEffort: "high" as const,
    requestTimeoutMs: 1000
  };
  const result = await createLlmTextResponse(
    primary as never,
    {
      ...baseRuntime,
      model: "primary",
      baseUrl: "https://primary.invalid/v1",
      apiKey: "primary-key"
    },
    [{ role: "user", content: "ping" }],
    {
      quotaFallbacks: [
        {
          client: unauthorizedBackup as never,
          runtime: {
            ...baseRuntime,
            model: "unauthorized-backup",
            baseUrl: "https://unauthorized.invalid/v1",
            apiKey: "unauthorized-key"
          }
        },
        {
          client: secondBackup as never,
          runtime: {
            ...baseRuntime,
            model: "second-backup",
            baseUrl: "https://second.invalid/v1",
            apiKey: "second-key"
          }
        }
      ]
    }
  );

  assert.equal(result, "second-backup-ok");
  assert.equal(secondBackupCalls, 1);
});
