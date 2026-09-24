import fs from "node:fs";
import type { Agent } from "node:http";
import { createRequire } from "node:module";
import { OpenAI } from "openai";
import type {
  LlmReasoningEffort,
  LlmWireApi,
  ModelCenterAgentName,
  ModelCenterAgentOverrideFields,
  ModelCenterFieldSource,
  ModelCenterFieldSources
} from "@zhihu-mvp/shared";
import { modelCenterAgentDefinitions } from "@zhihu-mvp/shared";
import toml from "toml";
import { getAppConfig } from "./env.js";
import {
  createEmptyModelCenterOverrideFields,
  readModelCenterAgentOverride
} from "./model-center-store.js";

type CodexProviderConfig = {
  model_provider?: string;
  model?: string;
  model_reasoning_effort?: string;
  model_providers?: Record<string, { base_url?: string; wire_api?: string }>;
};

type CodexAuthConfig = {
  OPENAI_API_KEY?: string;
};

type ApiKeySource = "override" | "env" | "codex_auth";

type BaseRuntimeResolution = {
  runtime: LlmRuntimeConfig;
  fieldSources: ModelCenterFieldSources;
  apiKeySource: ApiKeySource;
  providerName: string;
};

export interface LlmRuntimeConfig {
  model: string;
  reasoningEffort: LlmReasoningEffort;
  baseUrl: string;
  apiKey: string;
  proxyUrl: string | null;
  wireApi: LlmWireApi;
  requestTimeoutMs: number;
}

export type LlmConfigScope = "zhihu" | "ops" | "x" | "video";
export type LlmConfigTarget = LlmConfigScope | ModelCenterAgentName;

export type ResolvedLlmRuntimeConfig = {
  target: LlmConfigTarget;
  scope: LlmConfigScope;
  runtime: LlmRuntimeConfig;
  fallbackRuntime: LlmRuntimeConfig;
  overrides: ModelCenterAgentOverrideFields;
  fallbackFieldSources: ModelCenterFieldSources;
  fieldSources: ModelCenterFieldSources;
  apiKeySource: ApiKeySource;
  providerName: string;
};

const require = createRequire(import.meta.url);
const MODEL_CENTER_AGENT_SCOPE_MAP = new Map(modelCenterAgentDefinitions.map((definition) => [definition.name, definition.scope]));

export function resolveLlmRuntimeConfig(target: LlmConfigTarget = "zhihu"): ResolvedLlmRuntimeConfig {
  const scope = getLlmConfigScope(target);
  const config = getAppConfig();
  const parsedToml = readCodexToml(config.codexConfigPath);
  const parsedAuth = readCodexAuth(config.codexAuthPath);
  const baseResolution = buildBaseRuntimeResolution(scope, parsedToml, parsedAuth);
  const overrides = isModelCenterAgentName(target)
    ? readModelCenterAgentOverride(target)
    : createEmptyModelCenterOverrideFields();
  const scopedEnvOverrides = readScopedEnvOverrides(scope);
  const model = pickAgentRuntimeValue(overrides.model, scopedEnvOverrides.model, baseResolution.runtime.model, baseResolution.fieldSources.model);
  const baseUrl = pickAgentRuntimeValue(overrides.baseUrl, scopedEnvOverrides.baseUrl, baseResolution.runtime.baseUrl, baseResolution.fieldSources.baseUrl);
  const apiKey = pickAgentRuntimeValue(overrides.apiKey, scopedEnvOverrides.apiKey, baseResolution.runtime.apiKey, baseResolution.fieldSources.apiKey);
  const reasoningEffort = pickAgentRuntimeValue(
    overrides.reasoningEffort,
    scopedEnvOverrides.reasoningEffort,
    baseResolution.runtime.reasoningEffort,
    baseResolution.fieldSources.reasoningEffort
  );
  const wireApi = pickAgentRuntimeValue(
    overrides.wireApi,
    scopedEnvOverrides.wireApi,
    baseResolution.runtime.wireApi,
    baseResolution.fieldSources.wireApi
  );
  const requestTimeoutMs = pickAgentRuntimeValue(
    overrides.requestTimeoutMs,
    scopedEnvOverrides.requestTimeoutMs,
    baseResolution.runtime.requestTimeoutMs,
    baseResolution.fieldSources.requestTimeoutMs
  );

  return {
    target,
    scope,
    runtime: {
      ...baseResolution.runtime,
      model: model.value,
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
      reasoningEffort: reasoningEffort.value,
      wireApi: wireApi.value,
      requestTimeoutMs: requestTimeoutMs.value
    },
    fallbackRuntime: baseResolution.runtime,
    overrides,
    fallbackFieldSources: baseResolution.fieldSources,
    fieldSources: {
      model: model.source,
      baseUrl: baseUrl.source,
      apiKey: apiKey.source,
      reasoningEffort: reasoningEffort.source,
      wireApi: wireApi.source,
      requestTimeoutMs: requestTimeoutMs.source
    },
    apiKeySource: apiKey.source === "override" || apiKey.source === "env" || apiKey.source === "codex_auth" ? apiKey.source : baseResolution.apiKeySource,
    providerName: baseResolution.providerName
  };
}

export function readLlmRuntimeConfig(target: LlmConfigTarget = "zhihu"): LlmRuntimeConfig {
  return resolveLlmRuntimeConfig(target).runtime;
}

const cloudflareSafeClientHeaders = {
  // Dudu 前面的 Cloudflare 会按客户端特征拦截：Python-urllib 直接 1010，
  // OpenAI SDK 自带的 OpenAI/JS 和 X-Stainless-* 会把连接挂死。curl 默认头可以直连通过。
  "User-Agent": "curl/8.5.0",
  "X-Stainless-Lang": null,
  "X-Stainless-Package-Version": null,
  "X-Stainless-OS": null,
  "X-Stainless-Arch": null,
  "X-Stainless-Runtime": null,
  "X-Stainless-Runtime-Version": null,
  "X-Stainless-Retry-Count": null,
  "X-Stainless-Timeout": null
};

export function createOpenAiClient(target: LlmConfigTarget = "zhihu") {
  const runtime = readLlmRuntimeConfig(target);
  return new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl,
    httpAgent: createProxyAgent(runtime.proxyUrl),
    timeout: runtime.requestTimeoutMs,
    defaultHeaders: cloudflareSafeClientHeaders
  });
}

export function getLlmConfigScope(target: LlmConfigTarget): LlmConfigScope {
  if (isLlmConfigScope(target)) {
    return target;
  }

  return MODEL_CENTER_AGENT_SCOPE_MAP.get(target) ?? "zhihu";
}

function buildBaseRuntimeResolution(
  scope: LlmConfigScope,
  parsedToml: CodexProviderConfig,
  parsedAuth: CodexAuthConfig
): BaseRuntimeResolution {
  const providerEnv = readScopedEnv(scope, "PROVIDER");
  const providerName = providerEnv ?? parsedToml.model_provider ?? "sub2api";
  const providerConfig = parsedToml.model_providers?.[providerName] ?? {};

  const model = resolveStringField(readScopedEnv(scope, "MODEL"), parsedToml.model, "gpt-5.4");
  const baseUrl = resolveStringField(readScopedEnv(scope, "BASE_URL"), providerConfig.base_url, "https://vpsairobot.com");
  const reasoning = resolveReasoningField(readScopedEnv(scope, "REASONING_EFFORT"), parsedToml.model_reasoning_effort);
  const wireApi = resolveWireApiField(readScopedEnv(scope, "WIRE_API"), providerConfig.wire_api);
  const requestTimeoutMs = resolveRequestTimeoutField(readScopedEnv(scope, "REQUEST_TIMEOUT_MS"));
  const apiKeyEnv = readScopedEnv(scope, "API_KEY");
  const apiKey = apiKeyEnv ?? normalizeOptionalString(parsedAuth.OPENAI_API_KEY);

  if (!apiKey) {
    throw new Error("Missing LLM_API_KEY in project env or OPENAI_API_KEY in ~/.codex/auth.json");
  }

  return {
    runtime: {
      model: model.value,
      reasoningEffort: reasoning.value,
      baseUrl: baseUrl.value,
      apiKey,
      proxyUrl: resolveProxyUrl(),
      wireApi: wireApi.value,
      requestTimeoutMs: requestTimeoutMs.value
    },
    fieldSources: {
      model: model.source,
      baseUrl: baseUrl.source,
      apiKey: apiKeyEnv ? "env" : "codex_auth",
      reasoningEffort: reasoning.source,
      wireApi: wireApi.source,
      requestTimeoutMs: requestTimeoutMs.source
    },
    apiKeySource: apiKeyEnv ? "env" : "codex_auth",
    providerName
  };
}

function readCodexToml(filePath: string): CodexProviderConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return toml.parse(fs.readFileSync(filePath, "utf8")) as CodexProviderConfig;
}

function readCodexAuth(filePath: string): CodexAuthConfig {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as CodexAuthConfig;
}

function readScopedEnv(scope: LlmConfigScope, name: string) {
  const candidates =
    scope === "ops"
      ? [`OPS_AGENT_${name}`, `ZHIHU_AGENT_${name}`, `LLM_${name}`]
      : scope === "video"
        ? [`VIDEO_AGENT_${name}`, `LLM_${name}`, `ZHIHU_AGENT_${name}`]
      : scope === "x"
        ? [`X_AGENT_${name}`, `LLM_${name}`, `ZHIHU_AGENT_${name}`]
        : [`ZHIHU_AGENT_${name}`, `LLM_${name}`];

  for (const key of candidates) {
    const value = normalizeOptionalString(process.env[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function readScopedEnvOverrides(scope: LlmConfigScope) {
  return {
    model: readScopedEnv(scope, "MODEL"),
    baseUrl: readScopedEnv(scope, "BASE_URL"),
    apiKey: readScopedEnv(scope, "API_KEY"),
    reasoningEffort: normalizeReasoning(readScopedEnv(scope, "REASONING_EFFORT")),
    wireApi: normalizeWireApi(readScopedEnv(scope, "WIRE_API")),
    requestTimeoutMs: normalizeRequestTimeout(readScopedEnv(scope, "REQUEST_TIMEOUT_MS"))
  } satisfies {
    model: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    reasoningEffort: LlmReasoningEffort | null;
    wireApi: LlmWireApi | null;
    requestTimeoutMs: number | null;
  };
}

function resolveStringField(envValue: string | null, codexValue: string | undefined, fallback: string) {
  if (envValue) {
    return {
      value: envValue,
      source: "env"
    } satisfies { value: string; source: ModelCenterFieldSource };
  }

  const normalizedCodexValue = normalizeOptionalString(codexValue);
  if (normalizedCodexValue) {
    return {
      value: normalizedCodexValue,
      source: "codex_config"
    } satisfies { value: string; source: ModelCenterFieldSource };
  }

  return {
    value: fallback,
    source: "default"
  } satisfies { value: string; source: ModelCenterFieldSource };
}

function resolveReasoningField(envValue: string | null, codexValue: string | undefined) {
  const normalizedEnvValue = normalizeReasoning(envValue);
  if (normalizedEnvValue) {
    return {
      value: normalizedEnvValue,
      source: "env"
    } satisfies { value: LlmReasoningEffort; source: ModelCenterFieldSource };
  }

  const normalizedCodexValue = normalizeReasoning(codexValue);
  if (normalizedCodexValue) {
    return {
      value: normalizedCodexValue,
      source: "codex_config"
    } satisfies { value: LlmReasoningEffort; source: ModelCenterFieldSource };
  }

  return {
    value: "high",
    source: "default"
  } satisfies { value: LlmReasoningEffort; source: ModelCenterFieldSource };
}

function resolveWireApiField(envValue: string | null, codexValue: string | undefined) {
  const normalizedEnvValue = normalizeWireApi(envValue);
  if (normalizedEnvValue) {
    return {
      value: normalizedEnvValue,
      source: "env"
    } satisfies { value: LlmWireApi; source: ModelCenterFieldSource };
  }

  const normalizedCodexValue = normalizeWireApi(codexValue);
  if (normalizedCodexValue) {
    return {
      value: normalizedCodexValue,
      source: "codex_config"
    } satisfies { value: LlmWireApi; source: ModelCenterFieldSource };
  }

  return {
    value: "responses",
    source: "default"
  } satisfies { value: LlmWireApi; source: ModelCenterFieldSource };
}

function resolveRequestTimeoutField(envValue: string | null) {
  const normalizedEnvValue = normalizeRequestTimeout(envValue);
  if (normalizedEnvValue != null) {
    return {
      value: normalizedEnvValue,
      source: "env"
    } satisfies { value: number; source: ModelCenterFieldSource };
  }

  return {
    value: 3_600_000,
    source: "default"
  } satisfies { value: number; source: ModelCenterFieldSource };
}

function normalizeReasoning(value?: string | null): LlmReasoningEffort | null {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return null;
}

function normalizeWireApi(value?: string | null): LlmWireApi | null {
  if (value === "responses" || value === "chat_completions") {
    return value;
  }

  return null;
}

function normalizeRequestTimeout(value: string | null) {
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric);
  }

  return null;
}

function pickAgentRuntimeValue<T>(
  overrideValue: T | null,
  envValue: T | null,
  fallbackValue: T,
  fallbackSource: ModelCenterFieldSource
): { value: T; source: ModelCenterFieldSource } {
  if (overrideValue != null && overrideValue !== "") {
    return {
      value: overrideValue,
      source: "override"
    };
  }

  if (envValue != null && envValue !== "") {
    return {
      value: envValue,
      source: "env"
    };
  }

  return {
    value: fallbackValue,
    source: fallbackSource
  };
}

function resolveProxyUrl() {
  const proxyValue = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.ALL_PROXY;
  if (!proxyValue) {
    return null;
  }

  return normalizeProxyUrl(proxyValue);
}

function normalizeProxyUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return `http://127.0.0.1:${trimmed}`;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function createProxyAgent(proxyUrl: string | null): Agent | undefined {
  if (!proxyUrl) {
    return undefined;
  }

  const proxyModule = require("next/dist/compiled/https-proxy-agent");
  const HttpsProxyAgent = proxyModule.HttpsProxyAgent ?? proxyModule.default?.HttpsProxyAgent;
  if (!HttpsProxyAgent) {
    throw new Error("Missing HttpsProxyAgent runtime.");
  }

  return new HttpsProxyAgent(proxyUrl) as Agent;
}

function isLlmConfigScope(value: string): value is LlmConfigScope {
  return value === "zhihu" || value === "ops" || value === "x" || value === "video";
}

function isModelCenterAgentName(value: string): value is ModelCenterAgentName {
  return MODEL_CENTER_AGENT_SCOPE_MAP.has(value as ModelCenterAgentName);
}

function normalizeOptionalString(value: string | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
