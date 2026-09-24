import { z } from "zod";
import type {
  VideoScriptPack,
  VideoTargetPlatform,
  VideoTopicBatchOutput,
  VideoTopicCandidateSummary,
  VideoVerifiedCasePack,
  VisualRenderPlan
} from "@zhihu-mvp/shared";
import {
  videoScriptPackSchema,
  videoTopicBatchOutputSchema,
  visualRenderPlanSchema
} from "@zhihu-mvp/shared";
import type { LlmService } from "../services/llm-service.js";
import { loadVideoProductContext, type VideoProductContext } from "./video-product-context.js";

const LLM_TIMEOUT_MS = 600_000;

const productContextPromptSuffix = `Product context rules:
1. If input.productContext exists, treat it as the source of truth for CryptoPathX positioning, feature boundaries, allowed claims, prohibited claims, audience, workflows, user inputs, and outputs.
2. CryptoPathX must be described as a strategy research and analysis platform, not trading software, investment advice, profit guarantee, auto-trading, copy-trading, exchange custody, or one-click order execution.
3. Prefer topic and script angles around strategy creation, historical backtesting, signal monitoring, chart/pattern recognition, AI-assisted analysis, report interpretation, risk awareness, and repeatable research workflows.
4. When productContext conflicts with hotspot, userRequirement, or productBrief, follow productContext and put uncertainty in riskNotes.
5. WriterAgent must turn product features into concrete user scenarios and safe educational language. Avoid exaggerated sales claims and do not promise future returns.
6. VisualPlanner should use productContext to choose credible visuals: workflow cards, report cards, chart cards, backtest comparison screens, signal-monitoring concepts, and restrained product-explainer imagery.`;

const topicAgentPromptV2 = `You are Video Hub TopicAgent.

Goal: generate horizontal 16:9 video topic candidates for CryptoPathX.

Hard output rules:
1. Output strict JSON only. No markdown, no comments, no surrounding text.
2. The root JSON object must be exactly: { "summary": string, "candidates": array }.
3. candidates length should equal input.targetCount unless the brief is unsafe.
4. Every candidate object must include exactly these required fields:
   - title: string
   - brief: string
   - angle: string
   - videoFormat: one of "opinion", "data_explain", "tutorial", "case_breakdown", "product_explain", "mixed"
   - targetAudience: string
   - whyThis: string
   - estimatedDurationSec: integer between 60 and 300
   - score: integer 0-100
5. Optional fields allowed: topicFitScore, productionScore, scoreBreakdown, riskNotes, sourceRefs.
6. Do not use alternative field names such as description, format, reason, rationale, audience, duration, or confidence.
7. Topics must be safe for a strategy research and analysis platform. Do not imply auto-trading, exchange execution, copy-trading, guaranteed profit, investment advice, or one-click orders.
8. Each topic should be practical for a horizontal narrated video under 5 minutes. Do not compress the idea if quality needs more time.

Scoring:
- topicFitScore: product and audience fit.
- productionScore: how easy it is to make with narration, image/card/chart assets, and subtitles.
- score: overall score.`;

const hotspotScorePromptV2 = `You are Video Hub Hotspot Topic Scorer.

Goal: decide whether the input hotspot should become a CryptoPathX horizontal 16:9 video topic.

Hard output rules:
1. Output strict JSON only. No markdown, no comments, no surrounding text.
2. Root fields must be: topicFitScore, productionScore, score, reason, candidate.
3. topicFitScore, productionScore, and score must be integers from 0 to 100.
4. candidate is optional. If included, it must follow the exact VideoTopicCandidateInput fields:
   title, brief, angle, videoFormat, targetAudience, whyThis, estimatedDurationSec, score.
5. videoFormat must be one of "opinion", "data_explain", "tutorial", "case_breakdown", "product_explain", "mixed".
6. Only include a candidate when the hotspot can be safely connected to CryptoPathX without making investment advice or profit promises.`;

const writerAgentPromptV2 = `You are Video Hub WriterAgent.

Goal: convert a confirmed topic into a VideoScriptPack for a horizontal 16:9 narrated video.

Hard output rules:
1. Output strict JSON only. No markdown, no comments, no surrounding text.
2. The JSON must satisfy VideoScriptPack.
3. Required root fields: title, topicId, aspectRatio, targetDurationSec, voiceoverFullText, segments.
4. aspectRatio must be "16:9".
5. Each segment must include: segmentId, order, title, voiceover, subtitle, durationSec, imagePrompt, visualIntent.
6. segmentId should be stable strings like "seg-1", "seg-2".
7. voiceover must be natural spoken Chinese, ready for TTS. Do not include stage directions.
8. imagePrompt must describe a horizontal 16:9 visual. Do not create vertical composition prompts.
9. If a segment needs a chart, set needsChart=true and include chartSpec with a real data source or explicitly modeled data. Do not invent market facts.
10. Keep CryptoPathX claims safe: research, backtesting, signal monitoring, analysis, and workflow assistance only. No auto-trading, guaranteed returns, investment advice, or exchange execution.
11. When revisionInstruction is provided, revise previousScriptPack against that instruction and keep unchanged content only when it still fits.
12. For product-related content, use a knowledge-sharing-first structure: teach a useful concept, judgment framework, or research method first, then introduce CryptoPathX as a concrete way to apply that method. Avoid both sales copy and dry feature-manual narration.
13. Product mentions should feel like practical examples inside the educational flow. The script should still be valuable if the viewer only remembers the knowledge point.
14. Duration can be up to 300 seconds when the topic needs depth. Prioritize insight quality, reasoning density, and spoken rhythm over short-form compression.
15. Voice style guidance: use conversational Chinese with sharp logic, mild self-aware humor, common-mistake callouts, and clear analogies. Do not imitate any specific living person verbatim; extract only high-level presentation traits.
16. If input.verifiedCasePack exists, it is the only trusted source for real market-data numbers. Use only its review.allowedFacts for hard facts, turn review.findings into cautious explanations, and keep review.hypotheses as open questions.
17. Do not directly fetch data, execute strategies, judge strategy effectiveness, or add real metrics that are not present in verifiedCasePack.
18. If a topic needs a real case but verifiedCasePack is missing, request a CaseIntent in the script notes instead of inventing real data.`;

const visualPlannerPromptV2 = `You are Video Hub VisualPlanner.

Goal: choose the visual builder for every VideoScriptPack segment.

Hard output rules:
1. Output strict JSON only. No markdown, no comments, no surrounding text.
2. The JSON must satisfy VisualRenderPlan.
3. Root fields must include: projectId, aspectRatio, resolution, segments.
4. aspectRatio must be "16:9"; resolution must be { "width": 1920, "height": 1080 }.
5. Every segment plan must reference an existing script segmentId.
6. Every segment plan must include: segmentId, order, builder, reason.
7. order must match the source script segment order.
8. reason must explain why this builder is the right choice for that segment.
9. builder must be one of: "gpt_image", "hyperframe", "remotion_card", "existing_asset", "mixed".
10. Use gpt_image for conceptual scenes, product-explainer backgrounds, and narrative visuals.
11. Use remotion_card for title cards, quote cards, bullet cards, number cards, and CTA cards.
12. Use hyperframe only when there is a real chartSpec/data source and input.hyperframeEnabled is true.
13. If Hyperframe is needed but unavailable, choose hyperframe and set blockingIssue instead of silently downgrading.`;

const feedbackAgentPromptV2 = `You are Video Hub FeedbackAgent.

Goal: turn user feedback about topics, scripts, prompts, render plans, or finished videos into a reusable markdown feedback document.

Output markdown with:
1. What should TopicAgent change.
2. What should WriterAgent change.
3. What should VisualPlanner change.
4. Repeated user preferences.
5. Prohibited angles or wording.
6. Next experiments to try.

Do not replace the user as final publishing decision maker.`;

const hotspotScoreOutputSchema = z.object({
  topicFitScore: z.number().int().min(0).max(100),
  productionScore: z.number().int().min(0).max(100),
  score: z.number().int().min(0).max(100),
  reason: z.string().min(1),
  candidate: videoTopicBatchOutputSchema.shape.candidates.element.optional()
});

export type VideoHotspotScoreOutput = z.infer<typeof hotspotScoreOutputSchema>;

export class VideoAgentService {
  constructor(private readonly llmService: LlmService) {}

  async generateTopics(input: {
    source: string;
    targetPlatform: VideoTargetPlatform;
    targetCount: number;
    productBrief?: string;
    audience?: string;
    userRequirement?: string;
    hotspot?: unknown;
    feedbackDocuments?: string[];
  }): Promise<VideoTopicBatchOutput> {
    const productContext = await loadVideoProductContext();
    const responseText = await this.llmService.runSystemPrompt(
      withProductContextPrompt(topicAgentPromptV2),
      {
        ...input,
        productContext: buildProductContextPayload(productContext),
        aspectRatio: "16:9",
        outputLanguage: "简体中文"
      },
      LLM_TIMEOUT_MS,
      "Video TopicAgent returned empty response.",
      "video_topic_agent"
    );
    return parseStrictJson(responseText, videoTopicBatchOutputSchema, "Video TopicAgent");
  }

  async scoreHotspot(input: {
    hotspot: unknown;
    productBrief?: string;
    audience?: string;
    targetPlatform: VideoTargetPlatform;
  }) {
    const productContext = await loadVideoProductContext();
    const responseText = await this.llmService.runSystemPrompt(
      withProductContextPrompt(hotspotScorePromptV2),
      {
        ...input,
        productContext: buildProductContextPayload(productContext),
        aspectRatio: "16:9",
        outputLanguage: "简体中文"
      },
      LLM_TIMEOUT_MS,
      "Video hotspot scorer returned empty response.",
      "video_topic_agent"
    );
    return parseStrictJson(responseText, hotspotScoreOutputSchema, "Video hotspot scorer");
  }

  async generateScript(input: {
    projectId: string;
    topic: VideoTopicCandidateSummary;
    previousScriptPack?: VideoScriptPack | null;
    revisionInstruction?: string;
    verifiedCasePack?: VideoVerifiedCasePack | null;
  }): Promise<VideoScriptPack> {
    const productContext = await loadVideoProductContext();
    const responseText = await this.llmService.runSystemPrompt(
      withProductContextPrompt(writerAgentPromptV2),
      {
        projectId: input.projectId,
        topic: input.topic,
        previousScriptPack: input.previousScriptPack ?? null,
        verifiedCasePack: input.verifiedCasePack ?? null,
        revisionInstruction: input.revisionInstruction?.trim() || null,
        productContext: buildProductContextPayload(productContext),
        aspectRatio: "16:9",
        outputLanguage: "简体中文"
      },
      LLM_TIMEOUT_MS,
      "Video WriterAgent returned empty response.",
      "video_writer_agent"
    );
    const parsed = parseStrictJson(responseText, videoScriptPackSchema, "Video WriterAgent");
    return {
      ...parsed,
      topicId: input.topic.id,
      aspectRatio: "16:9"
    };
  }

  async generateVisualPlan(input: {
    projectId: string;
    scriptPack: VideoScriptPack;
    hyperframeEnabled: boolean;
  }): Promise<VisualRenderPlan> {
    const productContext = await loadVideoProductContext();
    const responseText = await this.llmService.runSystemPrompt(
      withProductContextPrompt(visualPlannerPromptV2),
      {
        ...input,
        productContext: buildProductContextPayload(productContext),
        aspectRatio: "16:9",
        resolution: {
          width: 1920,
          height: 1080
        },
        outputLanguage: "简体中文"
      },
      LLM_TIMEOUT_MS,
      "Video VisualPlanner returned empty response.",
      "video_visual_planner"
    );
    const parsed = parseStrictJson(responseText, visualRenderPlanSchema, "Video VisualPlanner", (value) =>
      normalizeVisualPlannerJson(value, input.projectId, input.scriptPack)
    );
    return {
      ...parsed,
      projectId: input.projectId,
      aspectRatio: "16:9",
      resolution: {
        width: parsed.resolution.width || 1920,
        height: parsed.resolution.height || 1080
      }
    };
  }

  async summarizeFeedback(input: {
    scope: string;
    notes: string;
    project?: unknown;
    candidates?: unknown[];
    recentFeedbackDocuments?: string[];
  }) {
    const responseText = await this.llmService.runSystemPrompt(
      feedbackAgentPromptV2,
      input,
      LLM_TIMEOUT_MS,
      "Video FeedbackAgent returned empty response.",
      "video_feedback_agent"
    );
    return responseText.trim();
  }
}

function buildProductContextPayload(context: VideoProductContext | null) {
  if (!context) {
    return null;
  }

  return {
    sourcePaths: context.sourcePaths,
    missingPaths: context.missingPaths,
    combinedMarkdown: context.combinedMarkdown
  };
}

function withProductContextPrompt(prompt: string) {
  return `${prompt}\n\n${productContextPromptSuffix}`;
}

function parseStrictJson<T>(
  value: string,
  schema: z.ZodType<T>,
  label: string,
  normalizer?: (value: unknown) => unknown
): T {
  const trimmed = value.trim();
  if (trimmed.startsWith("```")) {
    throw new Error(`${label} returned markdown-wrapped JSON, which is not allowed.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const normalized = normalizeLlmJson(parsed);
  return schema.parse(normalizer ? normalizer(normalized) : normalized);
}

function normalizeVisualPlannerJson(value: unknown, projectId: string, scriptPack: VideoScriptPack): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const plan = value as Record<string, unknown>;
  const rawSegments = Array.isArray(plan.segments) ? plan.segments : [];
  const scriptSegments = new Map(scriptPack.segments.map((segment) => [segment.segmentId, segment]));

  return {
    ...plan,
    projectId: typeof plan.projectId === "string" && plan.projectId.trim() ? plan.projectId : projectId,
    aspectRatio: "16:9",
    resolution:
      plan.resolution && typeof plan.resolution === "object"
        ? plan.resolution
        : {
            width: 1920,
            height: 1080
          },
    segments: rawSegments.map((rawSegment, index) => {
      const segment = rawSegment && typeof rawSegment === "object" ? (rawSegment as Record<string, unknown>) : {};
      const segmentId =
        typeof segment.segmentId === "string" && segment.segmentId.trim()
          ? segment.segmentId
          : scriptPack.segments[index]?.segmentId ?? `seg-${index + 1}`;
      const scriptSegment = scriptSegments.get(segmentId) ?? scriptPack.segments[index];
      const builder =
        typeof segment.builder === "string" && segment.builder.trim()
          ? segment.builder
          : scriptSegment?.needsChart
            ? "remotion_card"
            : "gpt_image";
      const reason =
        typeof segment.reason === "string" && segment.reason.trim()
          ? segment.reason
          : `Use ${builder} for script segment ${segmentId}.`;

      return {
        ...segment,
        segmentId,
        order: typeof segment.order === "number" ? segment.order : scriptSegment?.order ?? index + 1,
        builder,
        reason,
        imagePrompt: segment.imagePrompt ?? scriptSegment?.imagePrompt ?? null,
        chartSpec: segment.chartSpec ?? scriptSegment?.chartSpec ?? null
      };
    })
  };
}

function normalizeLlmJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeLlmJson(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "riskNotes" || key === "sourceRefs") && typeof item === "string") {
      normalized[key] = item.trim() ? [item] : [];
      continue;
    }
    normalized[key] = normalizeLlmJson(item);
  }
  return normalized;
}

const topicAgentPrompt = `你是视频制作中台的 TopicAgent。
目标：基于产品文档、受众、历史反馈和可选热点，生成横版 16:9 视频选题候选。
硬性要求：
1. 只输出 JSON，不要 Markdown，不要解释。
2. 输出必须符合 VideoTopicBatchOutput：{ "summary": string, "candidates": [...] }。
3. candidates 数量尽量等于 targetCount，最多 20 个。
4. 每个候选必须适合横版视频表达，避免需要竖版短视频语境才成立的选题。
5. score、topicFitScore、productionScore 均为 0-100 的整数。
6. 不确定的信息写入 riskNotes，不要写成事实。`;

const hotspotScorePrompt = `你是视频制作中台的热点选题评分器。
目标：判断输入热点是否适合转成当前产品/账号的横版视频选题。
硬性要求：
1. 只输出 JSON，不要 Markdown，不要解释。
2. 输出字段：topicFitScore, productionScore, score, reason, candidate。
3. candidate 可选；当 score 较高时给出一个完整候选，字段与 VideoTopicCandidateInput 一致。
4. 分数标准：topicFitScore 看产品/受众相关性，productionScore 看视频化可生产性，score 为综合分。
5. 不确定的信息写入 riskNotes，不要写成事实。`;

const writerAgentPrompt = `你是视频制作中台的 WriterAgent。
目标：把用户确认命中的 topic 转为横版 16:9 视频脚本包。
硬性要求：
1. 只输出 JSON，不要 Markdown，不要解释。
2. 输出必须符合 VideoScriptPack。
3. 口播文案要自然、清晰、可直接 TTS，不要舞台说明。
4. segments 必须可独立生产，每段包含 voiceover、subtitle、durationSec、imagePrompt、visualIntent。
5. 每段 imagePrompt 必须是横版画面 prompt，不要竖版构图。
6. 若需要图表，设置 needsChart=true 并提供 chartSpec；没有数据源时不要编造正式图表。`;

const visualPlannerPrompt = `你是视频制作中台的 VisualPlanner。
目标：为 VideoScriptPack 的每个 segment 决定视觉生产方式。
硬性要求：
1. 只输出 JSON，不要 Markdown，不要解释。
2. 输出必须符合 VisualRenderPlan。
3. builder 只能是 gpt_image、hyperframe、remotion_card、existing_asset、mixed。
4. Remotion 是最终合成层，不是与 Hyperframe 的二选一替代品。
5. Hyperframe 只用于图表/数据/结构化画面；没有明确数据源时不要选择 hyperframe。
6. GPT image 用于场景图、背景图、封面感画面。
7. remotion_card 用于标题、引用、要点、数字和 CTA 等结构化文本卡片。
8. 所有视觉都必须适配 16:9，默认 1920x1080。`;

const feedbackAgentPrompt = `你是视频制作中台的 FeedbackAgent。
目标：把用户对选题、脚本、配图 prompt、render plan 和成片的反馈沉淀成可复用文档。
输出要求：
1. 输出 Markdown 文档。
2. 明确列出对 TopicAgent、WriterAgent、VisualPlanner 的改进建议。
3. 把偏好、禁区、反复出现的问题和下次应优先尝试的方向分开写。
4. 不要替用户做最终发布决策。`;
