import fs from "node:fs";
import { modelCenterAgentNames } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import { createOpenAiClient, readLlmRuntimeConfig, type LlmRuntimeConfig } from "../config/llm-provider.js";
import { JobRepository } from "../repositories/job-repository.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { extractResponseText, parseJsonOrThrow } from "../utils/json.js";
import { createLlmTextResponse } from "../utils/llm-text.js";

const HUMANIZER_TIMEOUT_MS = 180_000;
const HUMANIZER_REPAIR_TIMEOUT_MS = 60_000;

let cachedHumanizerPrompt: string | null = null;

type HumanizerResponse = {
  content: string;
  notes: string[];
};

type HumanizerParseMode = "strict_json" | "content_only_fallback";

type HumanizerParseAttempt = {
  response: HumanizerResponse | null;
  errorMessage: string | null;
  mode: HumanizerParseMode | null;
};

type HumanizerContext = {
  publishJobId?: number | null;
  publishAttemptId?: number | null;
  stage?: string | null;
  agentName?: string;
  extraSystemPrompt?: string | null;
};

export class HumanizerService {
  constructor(private readonly jobRepository?: JobRepository) {}

  async humanize(content: string, context?: HumanizerContext): Promise<HumanizerResponse> {
    const startedAt = Date.now();
    logDebugTiming("humanizer.humanize", "start", {
      publishJobId: context?.publishJobId ?? null,
      stage: context?.stage ?? "humanizing",
      contentLength: content.length
    });
    const runtimeTarget = resolveHumanizerRuntimeTarget(context?.agentName);
    const client = createOpenAiClient(runtimeTarget);
    const runtime = readLlmRuntimeConfig(runtimeTarget);
    const prompt = loadHumanizerPrompt();
    let rawResponseText: string | null = null;
    let repairedResponseText: string | null = null;
    let directParseError: string | null = null;
    let repairedParseError: string | null = null;
    let repairErrorMessage: string | null = null;
    let parseMode: HumanizerParseMode | null = null;
    let parseWarning: string | null = null;

    try {
      const response = await createLlmTextResponse(
        client,
        runtime,
        buildHumanizerMessages(prompt, content, context?.extraSystemPrompt),
        {
          initialResponseTimeoutMs: HUMANIZER_TIMEOUT_MS
        }
      );

      rawResponseText = extractResponseText(response);
      const directParse = tryParseHumanizerResponse(rawResponseText);
      directParseError = directParse.errorMessage;
      parseMode = directParse.mode;
      parseWarning = directParse.response ? directParse.errorMessage : null;

      let parsed = directParse.response;
      if (!parsed) {
        try {
          repairedResponseText = await repairHumanizerResponse(rawResponseText, client, runtime);
        } catch (error) {
          repairErrorMessage = toErrorMessage(error);
          throw error;
        }

        if (repairedResponseText) {
          const repairedParse = tryParseHumanizerResponse(repairedResponseText);
          repairedParseError = repairedParse.errorMessage;
          parsed = repairedParse.response;
          parseMode = repairedParse.mode;
          parseWarning = repairedParse.response ? repairedParse.errorMessage : null;
        }
      }

      if (!parsed) {
        throw new Error("humanizer-zh returned invalid JSON after repair attempt.");
      }

      if (this.jobRepository) {
        await this.jobRepository.createSkillRun({
          publishJobId: context?.publishJobId ?? null,
          publishAttemptId: context?.publishAttemptId ?? null,
          skillName: "humanizer-zh",
          agentName: context?.agentName ?? "writer_agent",
          stage: context?.stage ?? "humanizing",
          inputJson: JSON.stringify({
            contentLength: content.length
          }),
          outputJson: JSON.stringify({
            contentLength: parsed.content.length,
            notes: parsed.notes,
            repairApplied: Boolean(repairedResponseText),
            parseMode,
            parseWarning
          }),
          durationMs: Date.now() - startedAt,
          success: true
        });
      }

      logDebugTiming("humanizer.humanize", "done", {
        publishJobId: context?.publishJobId ?? null,
        stage: context?.stage ?? "humanizing",
        elapsedMs: getElapsedMs(startedAt),
        repairApplied: Boolean(repairedResponseText),
        parseMode
      });
      return parsed;
    } catch (error) {
      if (this.jobRepository) {
        await this.jobRepository.createSkillRun({
          publishJobId: context?.publishJobId ?? null,
          publishAttemptId: context?.publishAttemptId ?? null,
          skillName: "humanizer-zh",
          agentName: context?.agentName ?? "writer_agent",
          stage: context?.stage ?? "humanizing",
          inputJson: JSON.stringify({
            contentLength: content.length
          }),
          outputJson: JSON.stringify({
            rawResponse: buildResponseDebugPreview(rawResponseText),
            repairedResponse: buildResponseDebugPreview(repairedResponseText),
            directParseError,
            repairedParseError,
            repairErrorMessage
          }),
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: toErrorMessage(error)
        });
      }

      logDebugTiming("humanizer.humanize", "failed", {
        publishJobId: context?.publishJobId ?? null,
        stage: context?.stage ?? "humanizing",
        elapsedMs: getElapsedMs(startedAt),
        error: toErrorMessage(error)
      });
      throw error;
    }
  }
}

function buildHumanizerMessages(prompt: string, content: string, extraSystemPrompt?: string | null) {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    {
      role: "system",
      content: prompt
    }
  ];

  const normalizedExtraPrompt = extraSystemPrompt?.trim();
  if (normalizedExtraPrompt) {
    messages.push({
      role: "system",
      content: normalizedExtraPrompt
    });
  }

  messages.push({
    role: "user",
    content
  });

  return messages;
}

function loadHumanizerPrompt() {
  if (cachedHumanizerPrompt) {
    return cachedHumanizerPrompt;
  }

  const config = getAppConfig();
  if (!fs.existsSync(config.humanizerSkillPath)) {
    throw new Error(`Missing local humanizer-zh skill at ${config.humanizerSkillPath}`);
  }

  const rawSkill = fs.readFileSync(config.humanizerSkillPath, "utf8");
  const skillBody = stripFrontmatter(rawSkill);
  cachedHumanizerPrompt = `${skillBody}

额外系统要求：
1. 严格遵守上面的 humanizer-zh 规则。
2. 不得改变事实边界、观点边界和核心结论。
3. 不得新增虚构数据。
4. 不要把“去 AI 味”理解为压缩正文。默认保留原文信息量，处理后长度不要低于原文的 85%，除非原文有明显重复废话。
5. 必须保留发布结构：如果原文有 **加粗** 重点，至少保留大部分加粗标记；如果原文有短列表、步骤清单或自检问题，不要全部改成普通段落。
6. 必须保留产品名（Dudu 中转站 / Dudu）、同类工具名、模型名、关键数字、账单区间、限流次数、超时时间和备用方案等事实信息。
7. 不得新增 api.dududu.cloud、dududu.cloud 或任何直接 API 域名。如果原文有指向文末 GitHub 仓库 「router-list」 的 **加粗** 引导句，必须保留加粗和仓库名。如果原文有「参考文献」和 https://github.com/hehesama527/router-list，必须原样保留，不要删掉、改写链接，或把 URL 挪进正文中间。
8. 可以调整句式、连接词、段落节奏和口语感，但不要删除 Topic/Review 可能依赖的结构锚点，例如粗体重点、列表、案例动作链和算账段。
9. 输出必须是 JSON，不要 Markdown，不要解释。
10. 输出格式固定为：
{
  "content": "处理后的正文",
  "notes": ["说明做了哪些自然化处理"]
}`;

  return cachedHumanizerPrompt;
}

function stripFrontmatter(value: string) {
  const normalized = value.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }

  const lines = normalized.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      return lines.slice(index + 1).join("\n").trim();
    }
  }

  return normalized.trim();
}

function tryParseHumanizerResponse(value: string): HumanizerParseAttempt {
  let parsed: unknown;

  try {
    parsed = parseJsonOrThrow<unknown>(value);
  } catch (error) {
    return recoverContentOnlyResponse(value, toErrorMessage(error));
  }

  if (!parsed || typeof parsed !== "object") {
    return recoverContentOnlyResponse(value, "humanizer-zh returned a non-object JSON payload.");
  }

  const content =
    typeof (parsed as { content?: unknown }).content === "string" ? (parsed as { content: string }).content : "";
  const notesRaw = (parsed as { notes?: unknown }).notes;
  const notes = Array.isArray(notesRaw) ? notesRaw.filter((item): item is string => typeof item === "string") : [];

  if (!content.trim()) {
    return recoverContentOnlyResponse(value, "humanizer-zh returned empty content.");
  }

  return {
    response: {
      content,
      notes
    },
    errorMessage: null,
    mode: "strict_json"
  };
}

async function repairHumanizerResponse(
  brokenResponse: string,
  client: ReturnType<typeof createOpenAiClient>,
  runtime: LlmRuntimeConfig
) {
  const repairPrompt = `You repair malformed JSON returned by a Chinese writing-humanizer tool.

Your task:
1. Convert the input into valid JSON only.
2. Preserve the original meaning and wording of the article content as much as possible.
3. Do not add new facts, new claims, or new product abilities.
4. Use this exact schema:
{
  "content": "string",
  "notes": ["string"]
}
5. If the input already contains article content but malformed JSON, fix escaping and structure only.
6. If notes are missing, return an empty array.
7. If notes are hard to preserve safely, return an empty array instead of quoting phrases from the article.
8. Do not use unescaped double quotes inside notes.
9. Do not wrap the answer in markdown fences.
10. Return JSON only.`;

  const response = await createLlmTextResponse(
    client,
    runtime,
    [
      {
        role: "system",
        content: repairPrompt
      },
      {
        role: "user",
        content: brokenResponse
      }
    ],
    {
      initialResponseTimeoutMs: HUMANIZER_REPAIR_TIMEOUT_MS
    }
  );

  return extractResponseText(response).trim() || null;
}

function buildResponseDebugPreview(value: string | null) {
  if (!value) {
    return null;
  }

  return {
    length: value.length,
    headPreview: value.slice(0, 1500),
    tailPreview: value.length > 1500 ? value.slice(-1500) : null
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown humanizer error";
}

function recoverContentOnlyResponse(value: string, baseErrorMessage: string): HumanizerParseAttempt {
  const content = extractJsonStringField(value, "content");
  if (!content?.trim()) {
    return {
      response: null,
      errorMessage: baseErrorMessage,
      mode: null
    };
  }

  return {
    response: {
      content,
      notes: []
    },
    errorMessage: `${baseErrorMessage}; recovered content only and dropped notes.`,
    mode: "content_only_fallback"
  };
}

function extractJsonStringField(value: string, fieldName: string) {
  const normalized = unwrapJsonFenceForRecovery(value);
  const pattern = new RegExp(`"${escapeRegex(fieldName)}"\\s*:\\s*"`, "u");
  const match = pattern.exec(normalized);
  if (!match) {
    return null;
  }

  let index = match.index + match[0].length;
  let result = "";

  while (index < normalized.length) {
    const current = normalized[index];
    if (current === "\"") {
      return result;
    }

    if (current !== "\\") {
      result += current;
      index += 1;
      continue;
    }

    const next = normalized[index + 1];
    if (next === undefined) {
      return null;
    }

    if (next === "u") {
      const code = normalized.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(code)) {
        return null;
      }
      result += String.fromCharCode(Number.parseInt(code, 16));
      index += 6;
      continue;
    }

    result += decodeJsonEscape(next);
    index += 2;
  }

  return null;
}

function decodeJsonEscape(value: string) {
  if (value === "\"" || value === "\\" || value === "/") {
    return value;
  }

  if (value === "b") {
    return "\b";
  }

  if (value === "f") {
    return "\f";
  }

  if (value === "n") {
    return "\n";
  }

  if (value === "r") {
    return "\r";
  }

  if (value === "t") {
    return "\t";
  }

  return value;
}

function unwrapJsonFenceForRecovery(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");
  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  if (firstLine.startsWith("```") && lastLine.startsWith("```")) {
    const middle = lines.slice(1, -1);
    if (middle[0]?.trim().toLowerCase() === "json") {
      return middle.slice(1).join("\n");
    }
    return middle.join("\n");
  }

  return trimmed;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveHumanizerRuntimeTarget(agentName?: string) {
  if (agentName && modelCenterAgentNames.includes(agentName as (typeof modelCenterAgentNames)[number])) {
    return agentName as (typeof modelCenterAgentNames)[number];
  }

  return "writer_agent" as const;
}
