import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBrowserChannel, type SupportedBrowserChannel } from "../utils/browser.js";

export interface AppConfig {
  mysqlUrl: string;
  apiPort: number;
  imageApiPort: number;
  webUrl: string;
  apiUrl: string;
  imageApiUrl: string;
  imageApiPublicBaseUrl: string;
  feishuBotWebhookUrl: string | null;
  feishuBotSecret: string | null;
  timezone: string;
  workspaceRoot: string;
  dataDir: string;
  codexHome: string;
  codexConfigPath: string;
  codexAuthPath: string;
  humanizerSkillPath: string;
  browserChannel: SupportedBrowserChannel;
  workerIntervalMs: number;
  opsAgentIntervalMs: number;
  topicKeywords: string[];
  zhihuBaseUrl: string;
  imageAssetsDir: string;
  imageAnalysisModel: string;
  imageOcrModel: string;
  imageOcrJudgeModel: string;
  ollamaBaseUrl: string;
  imageAnalysisConcurrency: number;
  imageAnalysisTimeoutMs: number;
  imageAnalysisRetryCount: number;
  antiDetectionV3Enabled: boolean;
  videoDir: string;
  videoImageModel: string;
  videoImageSize: string;
  videoRenderMock: boolean;
  videoWeeklyTopicDay: number;
  videoWeeklyTopicHour: number;
  videoWeeklyTopicCount: number;
  videoHotspotTopicThreshold: number;
  videoProductDocPaths: string[];
  videoProductDocMaxChars: number;
  videoCaseDataSource: string;
  videoCaseMongoUri: string;
  videoCaseMongoDb: string;
  videoCaseMongoKlineCollection: string | null;
  videoCaseAllowExternalBinanceFallback: boolean;
  cosyTtsBaseUrl: string | null;
  cosyTtsCommand: string | null;
  cosyGpuCheckCommand: string;
  hyperframeBaseUrl: string | null;
  remotionRenderCommand: string | null;
  layaApiUrl: string | null;
  layaEnabled: boolean;
}

let envLoaded = false;
let cachedWorkspaceRoot: string | null = null;
const initialProcessEnvKeys = new Set(Object.keys(process.env));

export function getAppConfig(): AppConfig {
  const workspaceRoot = findWorkspaceRoot();
  ensureWorkspaceEnvLoaded(workspaceRoot);
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");

  return {
    mysqlUrl: process.env.MYSQL_URL ?? "mysql://root:password@127.0.0.1:6306/zhihu_mvp",
    apiPort: Number(process.env.API_PORT ?? 8787),
    imageApiPort: Number(process.env.IMAGE_API_PORT ?? 8789),
    webUrl: process.env.WEB_URL ?? "http://localhost:3000",
    apiUrl: process.env.API_URL ?? "http://localhost:8787",
    imageApiUrl: process.env.IMAGE_API_URL ?? "http://localhost:8789",
    imageApiPublicBaseUrl:
      normalizeBaseUrl(process.env.IMAGE_API_PUBLIC_BASE_URL)
      ?? normalizeBaseUrl(process.env.NEXT_PUBLIC_IMAGE_API_BASE_URL)
      ?? "/image-api",
    feishuBotWebhookUrl: normalizeOptionalEnvValue(process.env.FEISHU_BOT_WEBHOOK_URL),
    feishuBotSecret: normalizeOptionalEnvValue(process.env.FEISHU_BOT_SECRET),
    timezone: process.env.APP_TIMEZONE ?? "Asia/Shanghai",
    workspaceRoot,
    dataDir: process.env.DATA_DIR ?? path.join(workspaceRoot, "data"),
    codexHome,
    codexConfigPath: process.env.CODEX_CONFIG_PATH ?? path.join(codexHome, "config.toml"),
    codexAuthPath: process.env.CODEX_AUTH_PATH ?? path.join(codexHome, "auth.json"),
    humanizerSkillPath:
      process.env.HUMANIZER_SKILL_PATH ?? path.join(codexHome, "skills", "humanizer-zh", "SKILL.md"),
    browserChannel: normalizeBrowserChannel(process.env.BROWSER_CHANNEL),
    workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 45_000),
    opsAgentIntervalMs: Number(process.env.OPS_AGENT_INTERVAL_MS ?? 60_000),
    // 2026-09 产品定位从 CryptoPathX 切换为 dudu 中转站。旧的 CryptoPathX 关键词默认值：
    // "币圈新手,加密货币市场,币圈交易,交易策略,止盈止损,趋势和震荡判断,量化回测,策略验证,可视化回测"
    topicKeywords: (process.env.TOPIC_KEYWORDS ??
      "Claude Code,Codex,GPT API,大模型中转,AI编程工具,API访问不稳定,开发者工具,OpenRouter平替,API调用成本,AI辅助编程")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    zhihuBaseUrl: process.env.ZHIHU_BASE_URL ?? "https://www.zhihu.com",
    imageAssetsDir: process.env.IMAGE_ASSETS_DIR ?? path.join(process.env.DATA_DIR ?? path.join(workspaceRoot, "data"), "image-assets"),
    imageAnalysisModel: process.env.IMAGE_ANALYSIS_MODEL ?? "qwen3-vl:8b",
    imageOcrModel: process.env.IMAGE_OCR_MODEL ?? process.env.IMAGE_ANALYSIS_MODEL ?? "qwen3-vl:8b",
    imageOcrJudgeModel:
      process.env.IMAGE_OCR_JUDGE_MODEL
      ?? process.env.IMAGE_OCR_MODEL
      ?? process.env.IMAGE_ANALYSIS_MODEL
      ?? "qwen3-vl:8b",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    imageAnalysisConcurrency: Number(process.env.IMAGE_ANALYSIS_CONCURRENCY ?? 1),
    imageAnalysisTimeoutMs: Number(process.env.IMAGE_ANALYSIS_TIMEOUT_MS ?? 180_000),
    imageAnalysisRetryCount: Number(process.env.IMAGE_ANALYSIS_RETRY_COUNT ?? 2),
    antiDetectionV3Enabled: process.env.ANTI_DETECTION_V3_ENABLED !== "false",
    videoDir: process.env.VIDEO_DATA_DIR ?? path.join(process.env.DATA_DIR ?? path.join(workspaceRoot, "data"), "videos"),
    videoImageModel: process.env.VIDEO_IMAGE_MODEL ?? "gpt-image-2.0",
    videoImageSize: process.env.VIDEO_IMAGE_SIZE ?? "1920x1080",
    videoRenderMock: process.env.VIDEO_RENDER_MOCK === "1" || process.env.VIDEO_RENDER_MOCK === "true",
    videoWeeklyTopicDay: Number(process.env.VIDEO_WEEKLY_TOPIC_DAY ?? 1),
    videoWeeklyTopicHour: Number(process.env.VIDEO_WEEKLY_TOPIC_HOUR ?? 9),
    videoWeeklyTopicCount: Number(process.env.VIDEO_WEEKLY_TOPIC_COUNT ?? 10),
    videoHotspotTopicThreshold: Number(process.env.VIDEO_HOTSPOT_TOPIC_THRESHOLD ?? 80),
    videoProductDocPaths: parseEnvList(process.env.VIDEO_PRODUCT_DOC_PATHS),
    videoProductDocMaxChars: Number(process.env.VIDEO_PRODUCT_DOC_MAX_CHARS ?? 24_000),
    videoCaseDataSource: process.env.VIDEO_CASE_DATA_SOURCE ?? "cryptopathx_mongo",
    videoCaseMongoUri: process.env.VIDEO_CASE_MONGO_URI ?? "mongodb://127.0.0.1:27017",
    videoCaseMongoDb: process.env.VIDEO_CASE_MONGO_DB ?? "crypto_data_new",
    videoCaseMongoKlineCollection: normalizeOptionalEnvValue(process.env.VIDEO_CASE_MONGO_KLINE_COLLECTION),
    videoCaseAllowExternalBinanceFallback:
      process.env.VIDEO_CASE_ALLOW_EXTERNAL_BINANCE_FALLBACK === "1" ||
      process.env.VIDEO_CASE_ALLOW_EXTERNAL_BINANCE_FALLBACK === "true",
    cosyTtsBaseUrl: normalizeOptionalEnvValue(process.env.COSY_TTS_BASE_URL),
    cosyTtsCommand: normalizeOptionalEnvValue(process.env.COSY_TTS_COMMAND),
    cosyGpuCheckCommand: process.env.COSY_GPU_CHECK_COMMAND ?? "nvidia-smi",
    hyperframeBaseUrl: normalizeOptionalEnvValue(process.env.HYPERFRAME_BASE_URL),
    remotionRenderCommand: normalizeOptionalEnvValue(process.env.REMOTION_RENDER_COMMAND),
    layaApiUrl: normalizeOptionalEnvValue(process.env.LAYA_API_URL) ?? "http://127.0.0.1:8100",
    layaEnabled: process.env.LAYA_ENABLED !== "false"
  };
}

function ensureWorkspaceEnvLoaded(workspaceRoot: string) {
  if (envLoaded) {
    return;
  }

  envLoaded = true;

  const envFiles = new Set<string>([...findEnvFiles(workspaceRoot), ...findEnvFiles(process.cwd())]);

  for (const filePath of envFiles) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, equalsIndex).trim();
      const rawValue = trimmed.slice(equalsIndex + 1).trim();
      if (!key || initialProcessEnvKeys.has(key)) {
        continue;
      }

      process.env[key] = unquoteEnvValue(rawValue);
    }
  }
}

function findWorkspaceRoot() {
  if (cachedWorkspaceRoot) {
    return cachedWorkspaceRoot;
  }

  const searchStarts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];

  for (const startDir of searchStarts) {
    const found = findUp(startDir, (candidate) => {
      const packageJsonPath = path.join(candidate, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return false;
      }

      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        return Array.isArray(pkg.workspaces);
      } catch {
        return false;
      }
    });

    if (found) {
      cachedWorkspaceRoot = found;
      return found;
    }
  }

  cachedWorkspaceRoot = process.cwd();
  return cachedWorkspaceRoot;
}

function findUp(startDir: string, predicate: (candidate: string) => boolean) {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (predicate(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function findEnvFiles(startDir: string) {
  const candidates: string[] = [];
  let currentDir = path.resolve(startDir);

  while (true) {
    candidates.push(path.join(currentDir, ".env"));
    candidates.push(path.join(currentDir, ".env.local"));

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }

    currentDir = parentDir;
  }

  return candidates;
}

function unquoteEnvValue(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function normalizeOptionalEnvValue(value: string | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseUrl(value: string | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

function parseEnvList(value: string | undefined) {
  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const delimiter = trimmed.includes(";") ? ";" : ",";
  return trimmed
    .split(delimiter)
    .map((item) => unquoteEnvValue(item.trim()))
    .filter(Boolean);
}
