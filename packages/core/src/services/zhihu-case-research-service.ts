import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { LlmService } from "./llm-service.js";

const CASE_RESEARCH_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_RAW_MATERIALS = 36;

const NEWS_FEEDS = [
  {
    label: "OpenAI News RSS",
    url: "https://openai.com/news/rss.xml",
    limit: 12
  },
  {
    label: "OpenAI Developers RSS",
    url: "https://developers.openai.com/rss.xml",
    limit: 10
  },
  {
    label: "OpenAI Engineering RSS",
    url: "https://openai.com/news/engineering/rss.xml",
    limit: 8
  }
] as const;

const STATUS_SOURCES = [
  {
    label: "OpenAI Status",
    url: "https://status.openai.com/api/v2/incidents.json",
    pageUrl: "https://status.openai.com"
  },
  {
    label: "Anthropic Status",
    url: "https://status.anthropic.com/api/v2/incidents.json",
    pageUrl: "https://status.anthropic.com"
  }
] as const;

const CASE_RESEARCH_TOPIC_PATTERNS = [
  /gpt/iu,
  /claude/iu,
  /codex/iu,
  /openrouter/iu,
  /openai|anthropic/iu,
  /\u5927\u6a21\u578b|\u4e2d\u8f6c|\u4ee3\u7406|\u9650\u6d41|\u63a5\u5165|\u90e8\u7f72|\u8c03\u7528|\u8ba1\u8d39|\u8d26\u5355|\u5c01\u53f7|\u98ce\u63a7/u,
  /\bAPI\b|\bSDK\b|\bToken\b|\b429\b/iu
];

type RawCaseMaterial = {
  source_type: "rss" | "market" | "source_context";
  source_label: string;
  source_url: string | null;
  title: string;
  summary: string;
  published_at: string | null;
  symbols: string[];
  metrics: Record<string, string | number | null>;
};

export type ZhihuCaseMaterial = {
  case_label: string;
  source_type: "rss" | "market" | "source_context" | "composite_hint";
  source_label: string;
  source_url: string;
  time_or_period: string;
  price_or_market_path: string;
  retail_entry_trigger: string;
  risk_mechanism: string;
  outcome_pressure: string;
  usable_angle: string;
  confidence: "high" | "medium" | "low";
  caution: string;
};

export type ZhihuCaseResearchOutput = {
  should_use_case_research: boolean;
  research_summary: string;
  case_materials: ZhihuCaseMaterial[];
  writer_guidance: string;
  must_not_claim: string[];
  collected_at: string;
  raw_material_count: number;
  failed_sources: string[];
};

type CaseResearchInput = {
  questionTitle: string;
  questionUrl?: string | null;
  topicCard?: Record<string, unknown> | null;
  sourceContext?: Record<string, unknown> | null;
};

type ParsedRssItem = {
  sourceLabel: string;
  title: string;
  link: string | null;
  summary: string;
  publishedAt: string | null;
};

type StatuspageIncidentsResponse = {
  incidents?: Array<{
    name?: string;
    status?: string;
    shortlink?: string;
    created_at?: string;
    updated_at?: string;
    incident_updates?: Array<{
      body?: string;
      status?: string;
      created_at?: string;
    }>;
  }>;
};

export class ZhihuCaseResearchService {
  constructor(private readonly llmService: LlmService) {}

  async research(input: CaseResearchInput): Promise<ZhihuCaseResearchOutput> {
    const startedAt = Date.now();
    const shouldResearch = shouldRunCaseResearch(input.questionTitle, input.topicCard);
    const fallback = buildFallbackResearch(input.questionTitle, shouldResearch);

    if (!shouldResearch) {
      return fallback;
    }

    logDebugTiming("zhihuCaseResearch.research", "start", {
      questionTitle: input.questionTitle
    });

    try {
      const { materials, failedSources } = await this.collectRawMaterials(input);
      const selectedMaterials = selectRelevantMaterials(input.questionTitle, materials);

      if (selectedMaterials.length === 0) {
        return {
          ...fallback,
          should_use_case_research: true,
          research_summary: "No reliable backend source material was collected; Writer should use a clearly typical/composite case.",
          failed_sources: failedSources
        };
      }

      const structured = await this.llmService.runJsonWithSystemPrompt<ZhihuCaseResearchOutput>(
        buildCaseResearchPrompt(),
        {
          questionTitle: input.questionTitle,
          questionUrl: input.questionUrl ?? null,
          topicCard: pickTopicCardResearchFields(input.topicCard),
          raw_materials: selectedMaterials.slice(0, MAX_RAW_MATERIALS)
        },
        {
          ...fallback,
          raw_material_count: selectedMaterials.length,
          failed_sources: failedSources
        },
        CASE_RESEARCH_TIMEOUT_MS
      );

      const normalized = normalizeCaseResearchOutput(structured, {
        ...fallback,
        raw_material_count: selectedMaterials.length,
        failed_sources: failedSources
      });

      logDebugTiming("zhihuCaseResearch.research", "done", {
        questionTitle: input.questionTitle,
        rawMaterialCount: selectedMaterials.length,
        caseMaterialCount: normalized.case_materials.length,
        elapsedMs: getElapsedMs(startedAt)
      });

      return normalized;
    } catch (error) {
      logDebugTiming("zhihuCaseResearch.research", "failed", {
        questionTitle: input.questionTitle,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: getElapsedMs(startedAt)
      });

      return {
        ...fallback,
        should_use_case_research: true,
        research_summary:
          "Backend case research failed; Writer should use a cautious typical/composite case and avoid claiming verified facts.",
        failed_sources: ["case_research_runtime"]
      };
    }
  }

  private async collectRawMaterials(input: CaseResearchInput) {
    const [newsResult, marketResult] = await Promise.allSettled([
      collectNewsMaterials(),
      collectMarketMaterials()
    ]);

    const materials: RawCaseMaterial[] = [
      ...collectSourceContextMaterials(input.sourceContext),
      ...(newsResult.status === "fulfilled" ? newsResult.value.materials : []),
      ...(marketResult.status === "fulfilled" ? marketResult.value.materials : [])
    ];

    const failedSources = [
      ...(newsResult.status === "fulfilled" ? newsResult.value.failedSources : ["news_research"]),
      ...(marketResult.status === "fulfilled" ? marketResult.value.failedSources : ["market_research"])
    ];

    return { materials, failedSources };
  }
}

function shouldRunCaseResearch(questionTitle: string, topicCard?: Record<string, unknown> | null) {
  const plan = topicCard && typeof topicCard.writing_plan === "object" ? (topicCard.writing_plan as Record<string, unknown>) : null;
  if (plan?.should_use_cases === true) {
    return true;
  }

  const text = [
    questionTitle,
    typeof topicCard?.title === "string" ? topicCard.title : "",
    typeof topicCard?.summary === "string" ? topicCard.summary : "",
    typeof topicCard?.question_type === "string" ? topicCard.question_type : "",
    typeof topicCard?.recommended_angle === "string" ? topicCard.recommended_angle : ""
  ].join("\n");

  return CASE_RESEARCH_TOPIC_PATTERNS.some((pattern) => pattern.test(text));
}

async function collectNewsMaterials() {
  const settled = await Promise.allSettled(
    NEWS_FEEDS.map(async (feed) => {
      const rssText = await fetchText(feed.url);
      return parseRssItems(rssText, feed.label).slice(0, feed.limit);
    })
  );

  const failedSources: string[] = [];
  const items = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }
    failedSources.push(`${NEWS_FEEDS[index].label}: ${toErrorMessage(result.reason)}`);
    return [];
  });

  return {
    failedSources,
    materials: items.map<RawCaseMaterial>((item) => ({
      source_type: "rss",
      source_label: item.sourceLabel,
      source_url: item.link,
      title: item.title,
      summary: item.summary,
      published_at: item.publishedAt,
      symbols: extractTopicSymbols(`${item.title}\n${item.summary}`),
      metrics: {}
    }))
  };
}

async function collectMarketMaterials() {
  const settled = await Promise.allSettled(STATUS_SOURCES.map((source) => collectStatusIncidents(source)));
  const failedSources: string[] = [];
  const materials: RawCaseMaterial[] = [];

  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      materials.push(...result.value);
      continue;
    }
    failedSources.push(`${STATUS_SOURCES[index].label}: ${toErrorMessage(result.reason)}`);
  }

  return { failedSources, materials };
}

async function collectStatusIncidents(source: (typeof STATUS_SOURCES)[number]) {
  const payload = await fetchJson<StatuspageIncidentsResponse>(source.url);
  const incidents = Array.isArray(payload.incidents) ? payload.incidents : [];

  return incidents.slice(0, 8).map<RawCaseMaterial>((incident) => {
    const latestUpdate = Array.isArray(incident.incident_updates) ? incident.incident_updates[0] : null;
    const title = pickString(incident.name, `${source.label} incident`);
    const summary = pickString(latestUpdate?.body, incident.status, title);

    return {
      source_type: "market",
      source_label: source.label,
      source_url: pickString(incident.shortlink, source.pageUrl) || source.pageUrl,
      title,
      summary,
      published_at: pickString(incident.updated_at, incident.created_at, latestUpdate?.created_at) || null,
      symbols: extractTopicSymbols(`${title}\n${summary}`),
      metrics: {
        incidentStatus: incident.status ?? null,
        updateStatus: latestUpdate?.status ?? null
      }
    };
  });
}

function collectSourceContextMaterials(sourceContext?: Record<string, unknown> | null): RawCaseMaterial[] {
  const events = Array.isArray(sourceContext?.sourceEvents) ? sourceContext.sourceEvents : [];
  const materials: RawCaseMaterial[] = [];

  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const record = event as Record<string, unknown>;
    const metadata = record.metadata && typeof record.metadata === "object" ? (record.metadata as Record<string, unknown>) : {};
    const title = pickString(metadata.title, metadata.questionTitle, metadata.text, record.title, record.sourceType);
    const summary = pickString(metadata.summary, metadata.description, metadata.content, metadata.extraContext, record.metadata);

    if (!title && !summary) {
      continue;
    }

    materials.push({
      source_type: "source_context",
      source_label: pickString(record.sourceType, "source_context") || `source_context_${index + 1}`,
      source_url: pickString(metadata.url, metadata.link, metadata.questionUrl) || null,
      title: title || `source_context_${index + 1}`,
      summary,
      published_at: pickString(record.discoveredAt, metadata.publishedAt, metadata.createdAt) || null,
      symbols: extractTopicSymbols(`${title}\n${summary}`),
      metrics: {}
    });
  }

  return materials.slice(-10);
}

function selectRelevantMaterials(questionTitle: string, materials: RawCaseMaterial[]) {
  return materials
    .map((material) => ({
      material,
      score: scoreMaterial(questionTitle, material)
    }))
    .filter((item) => item.score > 0 || item.material.source_type === "source_context")
    .sort((a, b) => b.score - a.score)
    .map((item) => item.material)
    .slice(0, MAX_RAW_MATERIALS);
}

function scoreMaterial(questionTitle: string, material: RawCaseMaterial) {
  const question = questionTitle.toLowerCase();
  const text = `${material.title}\n${material.summary}\n${material.symbols.join(" ")}`.toLowerCase();
  let score = 0;

  const genericTerms = [
    "gpt",
    "claude",
    "codex",
    "openai",
    "anthropic",
    "openrouter",
    "api",
    "rate limit",
    "429",
    "outage",
    "billing",
    "token",
    "sdk",
    "\u4e2d\u8f6c",
    "\u9650\u6d41",
    "\u8d26\u5355",
    "\u63a5\u5165",
    "\u8c03\u7528"
  ];

  for (const term of genericTerms) {
    if (text.includes(term)) {
      score += 2;
    }
  }

  const topicTerms = question
    .split(/[\s,，。?？!！:：;；/\\|()[\]{}"']+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  for (const term of topicTerms) {
    if (text.includes(term)) {
      score += 4;
    }
  }

  if (material.source_type === "market") {
    score += 3;
  }

  return score;
}

function buildCaseResearchPrompt() {
  return [
    "你是知乎发布链路里的案例研究 Agent，只负责把后端收集到的材料整理成写作 Agent 能用的案例，不写正文。",
    "来源材料只能用 raw_materials 里已有的事实。rss / market / source_context 材料不要编造精确事实。",
    "如果来源弱，就产出一条 source_type=composite_hint、confidence=low 的典型/复合案例。",
    "不要抄 RSS 原文，只改写。",
    "案例动作链要围绕开发者接入 GPT / Codex / Claude Code：项目背景、卡在哪一步（限流、超时、账单惊吓、官方故障、迁移）、试过什么、最终怎么选、还剩什么局限。",
    "字段沿用现有 JSON 名，但语义已经不是币圈：",
    "1. time_or_period：什么时候发生，例如高峰期、新模型放量周、出账单那天。",
    "2. price_or_market_path：访问、限流、账单或官方故障怎么演变，不要写币价路径。",
    "3. retail_entry_trigger：开发者为什么会踩这个坑，例如官方直连突然 429、账单跳涨、Claude Code 连不上。",
    "4. risk_mechanism：为什么会恶化，例如官方限流、灰色渠道挂掉、中转仍依赖上游。",
    "5. outcome_pressure：项目被卡住的代价，例如上线延期、调用中断、成本失控。",
    "措辞要谨慎。不要承诺保证可用、不要暗示能绕过官方限制、不要写成已验证的真实朋友或精确账单截图。",
    "叙述字段用简体中文。只输出 JSON。",
    "输出格式：",
    "{",
    '  "should_use_case_research": true,',
    '  "research_summary": "",',
    '  "case_materials": [',
    "    {",
    '      "case_label": "",',
    '      "source_type": "rss | market | source_context | composite_hint",',
    '      "source_label": "",',
    '      "source_url": "",',
    '      "time_or_period": "",',
    '      "price_or_market_path": "",',
    '      "retail_entry_trigger": "",',
    '      "risk_mechanism": "",',
    '      "outcome_pressure": "",',
    '      "usable_angle": "",',
    '      "confidence": "high | medium | low",',
    '      "caution": ""',
    "    }",
    "  ],",
    '  "writer_guidance": "",',
    '  "must_not_claim": [],',
    '  "collected_at": "",',
    '  "raw_material_count": 0,',
    '  "failed_sources": []',
    "}"
  ].join("\n");
}

function pickTopicCardResearchFields(topicCard?: Record<string, unknown> | null) {
  if (!topicCard) {
    return null;
  }

  return {
    title: topicCard.title,
    summary: topicCard.summary,
    question_type: topicCard.question_type,
    recommended_angle: topicCard.recommended_angle,
    writing_plan: topicCard.writing_plan,
    soft_promo_directive: topicCard.soft_promo_directive,
    risk_notes: topicCard.risk_notes
  };
}

function normalizeCaseResearchOutput(output: unknown, fallback: ZhihuCaseResearchOutput): ZhihuCaseResearchOutput {
  const record = output && typeof output === "object" ? (output as Record<string, unknown>) : {};
  const materials = Array.isArray(record.case_materials)
    ? record.case_materials.map(normalizeCaseMaterial).filter((item): item is ZhihuCaseMaterial => item !== null)
    : [];

  return {
    should_use_case_research:
      typeof record.should_use_case_research === "boolean" ? record.should_use_case_research : fallback.should_use_case_research,
    research_summary: pickString(record.research_summary, fallback.research_summary),
    case_materials: materials.slice(0, 4),
    writer_guidance: pickString(record.writer_guidance, fallback.writer_guidance),
    must_not_claim: normalizeStringArray(record.must_not_claim, fallback.must_not_claim),
    collected_at: pickString(record.collected_at, fallback.collected_at) || new Date().toISOString(),
    raw_material_count: normalizeNumber(record.raw_material_count, fallback.raw_material_count),
    failed_sources: normalizeStringArray(record.failed_sources, fallback.failed_sources)
  };
}

function normalizeCaseMaterial(value: unknown): ZhihuCaseMaterial | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const sourceType = normalizeSourceType(record.source_type);
  const confidence = normalizeConfidence(record.confidence);
  const caseLabel = pickString(record.case_label, record.source_label, "case_material");
  const usableAngle = pickString(record.usable_angle, record.risk_mechanism, record.price_or_market_path);

  if (!caseLabel && !usableAngle) {
    return null;
  }

  return {
    case_label: caseLabel || "case_material",
    source_type: sourceType,
    source_label: pickString(record.source_label, sourceType),
    source_url: pickString(record.source_url),
    time_or_period: pickString(record.time_or_period),
    price_or_market_path: pickString(record.price_or_market_path),
    retail_entry_trigger: pickString(record.retail_entry_trigger),
    risk_mechanism: pickString(record.risk_mechanism),
    outcome_pressure: pickString(record.outcome_pressure),
    usable_angle: usableAngle,
    confidence,
    caution: pickString(record.caution)
  };
}

function normalizeSourceType(value: unknown): ZhihuCaseMaterial["source_type"] {
  return value === "rss" || value === "market" || value === "source_context" || value === "composite_hint"
    ? value
    : "composite_hint";
}

function normalizeConfidence(value: unknown): ZhihuCaseMaterial["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function buildFallbackResearch(questionTitle: string, shouldResearch: boolean): ZhihuCaseResearchOutput {
  return {
    should_use_case_research: shouldResearch,
    research_summary: shouldResearch
      ? "Writer should use concrete case material. If no backend material is available, use a cautious typical/composite case."
      : "This topic does not require backend case research.",
    case_materials: shouldResearch
      ? [
          {
            case_label: "typical composite API access case",
            source_type: "composite_hint",
            source_label: "backend fallback",
            source_url: "",
            time_or_period: "高峰期或新模型放量后的一两周",
            price_or_market_path:
              "先官方直连能用，随后出现超时或连续 429，账单也比预期高；不要写成已验证的真实项目。",
            retail_entry_trigger: "小团队或独立开发者卡在 GPT / Claude Code 访问不稳，或突然收到偏高账单",
            risk_mechanism: "官方限流、网络环境、灰色渠道随时失效、中转服务仍依赖上游官方可用性",
            outcome_pressure: "调用中断、上线延期，或成本突然抬高后只能临时降级模型",
            usable_angle: "只有后端没有可靠来源时，才把这条当常见模式例子。",
            confidence: "low",
            caution: "不要把这条写成已验证的真实案例。"
          }
        ]
      : [],
    writer_guidance: shouldResearch
      ? "Use case material to carry the argument. Keep facts cautious and avoid repeating user-provided reference copy."
      : "",
    must_not_claim: [
      "不要声称有内部消息或官方合作。",
      "不要把有来源的案例写成自己核实过的事实，除非后端材料明确证明。",
      "不要把 composite_hint 写成真实朋友、真实账单截图或已验证项目。"
    ],
    collected_at: new Date().toISOString(),
    raw_material_count: 0,
    failed_sources: []
  };
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string) {
  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchWithTimeout(url: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS + attempt * 8_000);

    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: "application/rss+xml, application/xml, application/json, text/xml, */*",
          "user-agent": "Mozilla/5.0 zhihu-agent-case-research/1.0"
        }
      });
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        await sleep(500);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseRssItems(xml: string, sourceLabel: string): ParsedRssItem[] {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return items.map((block) => {
    const title = stripHtml(decodeHtmlEntities(extractXmlTag(block, "title")));
    const link = decodeHtmlEntities(extractXmlTag(block, "link")) || null;
    const summary = stripHtml(decodeHtmlEntities(extractXmlTag(block, "description") || extractXmlTag(block, "summary")));
    const published = extractXmlTag(block, "pubDate") || extractXmlTag(block, "published");

    return {
      sourceLabel,
      title,
      link,
      summary,
      publishedAt: normalizeDate(published)
    };
  });
}

function extractXmlTag(block: string, tagName: string) {
  const match = block.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  if (!match) {
    return "";
  }

  return match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCharCode(Number(digits)));
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeDate(value: string) {
  if (!value.trim()) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractTopicSymbols(text: string) {
  const upper = text.toUpperCase();
  const matches = upper.match(/\b[A-Z0-9][A-Z0-9._-]{1,24}\b/g) ?? [];
  const blocked = new Set(["THE", "AND", "FOR", "WITH", "THIS", "THAT", "FROM", "WILL", "HAVE", "HAS", "ARE", "HTTP", "HTTPS"]);

  return [...new Set(matches.filter((item) => !blocked.has(item)).slice(0, 8))];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pickString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function normalizeStringArray(value: unknown, fallback: string[] = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = value.map((item) => String(item).trim()).filter(Boolean);
  return normalized.length ? normalized : fallback;
}

function normalizeNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
