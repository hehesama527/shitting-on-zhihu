import { z } from "zod";
import { llmReasoningEfforts, llmWireApis, modelCenterAgentNames } from "./types.js";

export const promptSetNameSchema = z.enum([
  "topic_agent",
  "writer_agent",
  "review_agent",
  "publish_agent",
  "zhihu_note_agent",
  "x_main_agent",
  "x_hotspot_scout_agent",
  "x_writer_agent",
  "x_review_agent",
  "x_publish_agent",
  "x_traditional_main_agent",
  "x_traditional_writer_agent",
  "x_traditional_review_agent",
  "x_traditional_publish_agent",
  "x_traditional_note_agent",
  "video_topic_agent",
  "video_writer_agent",
  "video_review_agent",
  "video_visual_planner",
  "video_motion_planner",
  "video_feedback_agent"
]);

export const llmReasoningEffortSchema = z.enum(llmReasoningEfforts);
export const llmWireApiSchema = z.enum(llmWireApis);
export const modelCenterAgentNameSchema = z.enum(modelCenterAgentNames);

export const modelCenterAgentOverrideFieldsSchema = z.object({
  model: z.union([z.string().trim().min(1), z.null()]),
  baseUrl: z.union([z.string().trim().min(1), z.null()]),
  apiKey: z.union([z.string().trim().min(1), z.null()]),
  reasoningEffort: z.union([llmReasoningEffortSchema, z.null()]),
  wireApi: z.union([llmWireApiSchema, z.null()]),
  requestTimeoutMs: z.union([z.number().int().positive(), z.null()])
});

export const modelCenterAgentOverrideSchema = modelCenterAgentOverrideFieldsSchema.extend({
  agentName: modelCenterAgentNameSchema
});

export const modelCenterSavedModelSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  providerLabel: z.union([z.string().trim(), z.null()]).default(null),
  notes: z.union([z.string().trim(), z.null()]).default(null),
  overrides: modelCenterAgentOverrideFieldsSchema.default({
    model: null,
    baseUrl: null,
    apiKey: null,
    reasoningEffort: null,
    wireApi: null,
    requestTimeoutMs: null
  })
});

export const modelCenterAgentBindingSchema = z.object({
  agentName: modelCenterAgentNameSchema,
  modelId: z.union([z.string().trim().min(1), z.null()]).default(null)
});

export const imageModelCenterOverrideSchema = z.object({
  imageAnalysisModel: z.union([z.string().trim().min(1), z.null()]).default(null),
  imageOcrModel: z.union([z.string().trim().min(1), z.null()]).default(null),
  imageOcrJudgeModel: z.union([z.string().trim().min(1), z.null()]).default(null),
  ollamaBaseUrl: z.union([z.string().trim().min(1), z.null()]).default(null),
  imageAnalysisTimeoutMs: z.union([z.number().int().positive(), z.null()]).default(null)
});

export const updateModelCenterSchema = z
  .object({
    agents: z.array(modelCenterAgentOverrideSchema).default([]),
    models: z.array(modelCenterSavedModelSchema).default([]),
    agentBindings: z.array(modelCenterAgentBindingSchema).default([]),
    imageRuntime: imageModelCenterOverrideSchema.default({})
  })
  .refine(
    (value) => new Set(value.agents.map((item) => item.agentName)).size === value.agents.length,
    "Agent overrides must be unique."
  )
  .refine(
    (value) => new Set(value.models.map((item) => item.id)).size === value.models.length,
    "Saved model ids must be unique."
  )
  .refine(
    (value) => new Set(value.agentBindings.map((item) => item.agentName)).size === value.agentBindings.length,
    "Agent bindings must be unique."
  );

export const modelCenterStoredConfigSchema = z.object({
  version: z.number().int().positive().default(2),
  updatedAt: z.union([z.string().trim().min(1), z.null()]).default(null),
  imageRuntime: imageModelCenterOverrideSchema.default({}),
  models: z.array(modelCenterSavedModelSchema).default([]),
  agentBindings: z.array(modelCenterAgentBindingSchema).default([]),
  agents: z.array(modelCenterAgentOverrideSchema).default([])
});

export const videoTargetPlatformSchema = z.enum([
  "agnostic",
  "x",
  "zhihu",
  "douyin",
  "xiaohongshu",
  "bilibili",
  "manual"
]);
export const videoAspectRatioSchema = z.literal("16:9");
export const videoTopicSourceSchema = z.enum(["weekly", "hotspot", "manual", "platform_request", "refill"]);
export const videoTopicFeedbackDecisionSchema = z.enum(["hit", "miss", "not_now", "duplicate", "risky"]);
export const videoTopicCandidateStatusSchema = z.enum([
  "pending_feedback",
  "selected",
  "rejected",
  "deferred",
  "project_created",
  "expired"
]);
export const videoProjectStatusSchema = z.enum([
  "topic_selected",
  "writing",
  "script_pending_confirmation",
  "render_plan_pending_confirmation",
  "script_confirmed",
  "assets_pending",
  "voice_rendering",
  "visual_rendering",
  "assets_ready",
  "composing",
  "video_ready",
  "video_review_required",
  "approved",
  "failed",
  "archived"
]);
export const videoSegmentStatusSchema = z.enum([
  "planned",
  "script_ready",
  "script_confirmed",
  "voice_pending",
  "voice_rendering",
  "voice_ready",
  "visual_pending",
  "visual_rendering",
  "visual_ready",
  "ready",
  "failed",
  "superseded"
]);
export const videoAssetTypeSchema = z.enum([
  "voice",
  "image",
  "chart",
  "text_card",
  "subtitle",
  "video",
  "composition",
  "motion_plan"
]);
export const videoAssetStatusSchema = z.enum(["pending", "rendering", "active", "superseded", "failed"]);
export const videoRenderBuilderSchema = z.enum(["gpt_image", "hyperframe", "remotion_card", "existing_asset", "mixed"]);
export const videoMotionSceneTypeSchema = z.enum([
  "hook_curve_warning",
  "real_market_chart",
  "ma_crossover_rule",
  "single_window_result",
  "window_comparison",
  "market_weather",
  "diagnostic_cards",
  "product_workflow",
  "closing_standard",
  "text_card",
  "image_explainer"
]);
export const videoMotionDataRefTypeSchema = z.enum([
  "none",
  "verified_case_pack",
  "market_window",
  "market_window_comparison",
  "script_segment",
  "asset"
]);
export const videoMotionOverlayRoleSchema = z.enum(["headline", "subhead", "callout", "metric", "warning", "caption"]);
export const videoMotionOverlayPositionSchema = z.enum([
  "top_left",
  "top_center",
  "top_right",
  "center",
  "lower_left",
  "lower_center",
  "lower_right"
]);
export const videoMotionCameraSchema = z.enum(["none", "push_in", "pull_back", "pan_left", "pan_right", "track_chart"]);
export const videoMotionTransitionSchema = z.enum(["cut", "fade", "match_cut", "wipe", "slide"]);
export const videoMotionChartDrawSchema = z.enum(["none", "continuous", "candlestick_build", "line_trace", "bar_reveal"]);
export const videoMotionEmphasisSchema = z.enum([
  "none",
  "last_price_dot",
  "crossover_marker",
  "result_delta",
  "risk_badge",
  "workflow_step"
]);
export const videoCaseIntentStatusSchema = z.enum([
  "requested",
  "evidence_running",
  "evidence_ready",
  "review_failed",
  "abandoned"
]);
export const videoVerifiedCasePackStatusSchema = z.enum([
  "ready",
  "ready_with_warnings",
  "insufficient_evidence",
  "failed"
]);
export const videoCaseDataSourceSchema = z.literal("cryptopathx_mongo");
export const videoCaseStrategyNameSchema = z.literal("sma_crossover");
const videoCaseStrategyConfigBaseSchema = z.object({
  name: videoCaseStrategyNameSchema.default("sma_crossover"),
  fastWindow: z.number().int().min(2).max(400).default(20),
  slowWindow: z.number().int().min(3).max(800).default(60),
  side: z.literal("long_only").default("long_only")
});
export const videoCaseStrategyConfigSchema = videoCaseStrategyConfigBaseSchema.refine((value) => value.fastWindow < value.slowWindow, {
  message: "fastWindow must be lower than slowWindow."
});
export const videoCaseAssumptionsSchema = z.object({
  initialCapital: z.number().positive().default(10_000),
  feeBpsEachSide: z.number().min(0).max(1000).default(10),
  slippageBpsEachSide: z.number().min(0).max(1000).default(5)
});

export const videoTopicCandidateInputSchema = z.object({
  title: z.string().trim().min(4).max(120),
  brief: z.string().trim().min(10).max(1600),
  angle: z.string().trim().min(4).max(800),
  videoFormat: z.enum(["opinion", "data_explain", "tutorial", "case_breakdown", "product_explain", "mixed"]),
  targetAudience: z.string().trim().min(1).max(400),
  whyThis: z.string().trim().min(4).max(1000),
  estimatedDurationSec: z.union([z.number().int().min(30).max(300), z.null()]).optional(),
  score: z.number().int().min(0).max(100),
  topicFitScore: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
  productionScore: z.union([z.number().int().min(0).max(100), z.null()]).optional(),
  scoreBreakdown: z.record(z.number().int().min(-100).max(100)).default({}),
  riskNotes: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([])
});

export const videoTopicBatchOutputSchema = z.object({
  summary: z.string().trim().min(1),
  candidates: z.array(videoTopicCandidateInputSchema).min(1).max(20)
});

export const createVideoTopicBatchSchema = z.object({
  source: videoTopicSourceSchema.default("manual"),
  targetPlatform: videoTargetPlatformSchema.default("agnostic"),
  targetCount: z.number().int().min(1).max(20).default(10),
  productBrief: z.string().trim().default(""),
  audience: z.string().trim().default(""),
  userRequirement: z.string().trim().default(""),
  hotspot: z.record(z.any()).optional()
});

export const refillVideoTopicBatchSchema = z.object({
  targetCount: z.number().int().min(1).max(20).default(10),
  userRequirement: z.string().trim().default("")
});

export const videoHotspotScoreSchema = z.object({
  hotspot: z.record(z.any()),
  productBrief: z.string().trim().default(""),
  audience: z.string().trim().default(""),
  targetPlatform: videoTargetPlatformSchema.default("agnostic")
});

export const saveVideoTopicFeedbackSchema = z.object({
  decision: videoTopicFeedbackDecisionSchema,
  reason: z.string().trim().default(""),
  suggestion: z.string().trim().default("")
});

export const createVideoProjectSchema = z.object({
  topicCandidateId: z.string().trim().min(1),
  title: z.string().trim().optional()
});

export const createVideoCaseIntentSchema = z.object({
  dataSource: videoCaseDataSourceSchema.default("cryptopathx_mongo"),
  symbol: z.string().trim().min(3).max(32).transform((value) => value.toUpperCase()),
  interval: z.string().trim().min(2).max(16),
  startTime: z.string().trim().min(1),
  endTime: z.string().trim().min(1),
  collectionName: z.union([z.string().trim().min(1), z.null()]).optional(),
  strategy: videoCaseStrategyConfigBaseSchema.partial().optional(),
  assumptions: videoCaseAssumptionsSchema.partial().optional(),
  requestedCase: z.string().trim().max(1000).default(""),
  notes: z.string().trim().max(2000).default("")
});

export const generateVideoCaseReviewSchema = z.object({
  caseIntentId: z.string().trim().min(1).optional()
});

export const videoVerifiedCasePackSchema = z.object({
  caseId: z.string().trim().min(1),
  status: videoVerifiedCasePackStatusSchema,
  createdAt: z.string().trim().min(1),
  dataSource: z.record(z.any()),
  caseIntent: z.record(z.any()),
  strategy: z.record(z.any()),
  metrics: z.record(z.any()),
  review: z.object({
    allowedFacts: z.array(z.string().trim().min(1)).default([]),
    findings: z.array(z.string().trim().min(1)).default([]),
    hypotheses: z.array(z.string().trim().min(1)).default([]),
    forbiddenClaims: z.array(z.string().trim().min(1)).default([]),
    contentSafety: z.object({
      mustSay: z.array(z.string().trim().min(1)).default([])
    }),
    reviewScore: z.number().int().min(0).max(100).optional(),
    warnings: z.array(z.string().trim().min(1)).optional()
  }),
  chartData: z.record(z.any()).default({})
});

export const videoScriptSegmentSchema = z.object({
  segmentId: z.string().trim().min(1),
  order: z.number().int().min(1),
  title: z.string().trim().min(1).max(120),
  voiceover: z.string().trim().min(1).max(2500),
  subtitle: z.string().trim().min(1).max(600),
  durationSec: z.number().int().min(3).max(90),
  imagePrompt: z.string().trim().min(1).max(2500),
  visualIntent: z.string().trim().min(1).max(1200),
  needsChart: z.boolean().optional(),
  chartSpec: z.union([z.record(z.any()), z.null()]).optional()
});

export const videoScriptPackSchema = z.object({
  title: z.string().trim().min(1).max(160),
  topicId: z.string().trim().min(1),
  aspectRatio: videoAspectRatioSchema.default("16:9"),
  targetDurationSec: z.number().int().min(20).max(600),
  voiceoverFullText: z.string().trim().min(1).max(12000),
  segments: z.array(videoScriptSegmentSchema).min(1).max(24),
  coverTitle: z.string().trim().optional(),
  cta: z.string().trim().optional(),
  riskNotes: z.array(z.string()).default([])
});

export const saveVideoScriptPackSchema = z.object({
  scriptPack: videoScriptPackSchema
});

export const generateVideoScriptSchema = z.object({
  revisionInstruction: z.string().trim().max(4000).default(""),
  verifiedCasePackId: z.string().trim().min(1).optional()
});

export const visualRenderPlanSegmentSchema = z.object({
  segmentId: z.string().trim().min(1),
  order: z.number().int().min(1),
  builder: videoRenderBuilderSchema,
  reason: z.string().trim().min(1).max(1000),
  imagePrompt: z.union([z.string().trim(), z.null()]).optional(),
  chartSpec: z.union([z.record(z.any()), z.null()]).optional(),
  cardSpec: z.union([z.record(z.any()), z.null()]).optional(),
  existingAssetId: z.union([z.string().trim().min(1), z.null()]).optional(),
  blockingIssue: z.union([z.string().trim().min(1), z.null()]).optional()
});

export const visualRenderPlanSchema = z.object({
  projectId: z.string().trim().min(1),
  aspectRatio: videoAspectRatioSchema.default("16:9"),
  resolution: z.object({
    width: z.number().int().min(640).default(1920),
    height: z.number().int().min(360).default(1080)
  }),
  segments: z.array(visualRenderPlanSegmentSchema).min(1).max(24),
  notes: z.array(z.string()).default([])
});

export const saveVisualRenderPlanSchema = z.object({
  visualRenderPlan: visualRenderPlanSchema
});

export const videoMotionOverlaySchema = z
  .object({
    text: z.string().trim().min(1).max(80),
    role: videoMotionOverlayRoleSchema,
    position: videoMotionOverlayPositionSchema,
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).optional()
  })
  .refine((value) => value.startMs === undefined || value.endMs === undefined || value.endMs > value.startMs, {
    message: "Overlay endMs must be greater than startMs."
  });

export const videoMotionDataRefSchema = z.object({
  type: videoMotionDataRefTypeSchema,
  key: z.union([z.string().trim().min(1), z.null()]).optional(),
  source: z.union([z.string().trim().min(1), z.null()]).optional(),
  label: z.union([z.string().trim().min(1), z.null()]).optional()
});

export const videoMotionConfigSchema = z.object({
  transition: videoMotionTransitionSchema,
  camera: videoMotionCameraSchema,
  chartDraw: videoMotionChartDrawSchema,
  emphasis: videoMotionEmphasisSchema,
  layerAnimations: z.array(z.string().trim().min(1)).default([])
});

export const videoMotionQaRuleSchema = z.object({
  ruleId: z.string().trim().min(1).max(80),
  severity: z.enum(["error", "warning"]),
  description: z.string().trim().min(1).max(400),
  target: z.enum(["plan", "scene", "asset", "subtitle"])
});

export const videoMotionDataBindingSchema = z.object({
  key: z.string().trim().min(1).max(120),
  type: videoMotionDataRefTypeSchema,
  source: z.string().trim().min(1).max(240),
  label: z.string().trim().min(1).max(120),
  required: z.boolean().default(true),
  fallbackSceneType: videoMotionSceneTypeSchema.optional(),
  notes: z.string().trim().max(1000).optional()
});

export const videoMotionSceneSchema = z
  .object({
    sceneId: z.string().trim().min(1).max(120),
    segmentId: z.string().trim().min(1),
    segmentKey: z.string().trim().min(1),
    order: z.number().int().min(1),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    durationMs: z.number().int().min(500).max(120_000),
    sceneType: videoMotionSceneTypeSchema,
    narrationIntent: z.string().trim().min(1).max(600),
    dataRef: videoMotionDataRefSchema,
    visualFocus: z.string().trim().min(1).max(600),
    textOverlays: z.array(videoMotionOverlaySchema).max(6).default([]),
    motion: videoMotionConfigSchema,
    requiredAssetTypes: z.array(videoAssetTypeSchema).default([]),
    qaRules: z.array(videoMotionQaRuleSchema).default([])
  })
  .refine((value) => value.endMs > value.startMs, {
    message: "Scene endMs must be greater than startMs."
  })
  .refine((value) => Math.abs(value.endMs - value.startMs - value.durationMs) <= 33, {
    message: "Scene durationMs must match endMs - startMs within one frame."
  });

export const videoMotionPlanSchema = z
  .object({
    version: z.literal("motion-plan-v1"),
    projectId: z.string().trim().min(1),
    title: z.string().trim().min(1).max(160),
    aspectRatio: videoAspectRatioSchema.default("16:9"),
    resolution: z.object({
      width: z.number().int().min(640).default(1920),
      height: z.number().int().min(360).default(1080)
    }),
    totalDurationMs: z.number().int().min(500),
    maxSceneDurationMs: z.number().int().min(3_000).max(20_000).default(12_000),
    generatedAt: z.string().trim().min(1),
    source: z.object({
      planner: z.enum(["deterministic_v1", "agent_refined"]),
      inputs: z.array(z.string().trim().min(1)).default([])
    }),
    dataBindings: z.array(videoMotionDataBindingSchema).default([]),
    scenes: z.array(videoMotionSceneSchema).min(1).max(240),
    qaRules: z.array(videoMotionQaRuleSchema).default([]),
    notes: z.array(z.string()).default([])
  })
  .superRefine((value, context) => {
    if (value.resolution.width * 9 !== value.resolution.height * 16) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "MotionPlan MVP only supports 16:9 resolution."
      });
    }
    for (const scene of value.scenes) {
      if (scene.durationMs > value.maxSceneDurationMs) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", scene.order - 1, "durationMs"],
          message: "Scene duration exceeds MotionPlan maxSceneDurationMs."
        });
      }
    }
  });

export const saveVideoMotionPlanSchema = z.object({
  motionPlan: videoMotionPlanSchema
});

export const videoFeedbackDocumentInputSchema = z.object({
  scope: z.enum(["global", "topic", "writer", "visual", "project"]).default("global"),
  projectId: z.union([z.string().trim().min(1), z.null()]).optional(),
  notes: z.string().trim().default("")
});

export const createPromptDraftSchema = z.object({
  label: z.string().min(1),
  content: z.string().min(1),
  notes: z.string().default("")
});

export const updatePromptDraftSchema = z
  .object({
    label: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    notes: z.string().optional()
  })
  .refine((value) => value.label !== undefined || value.content !== undefined || value.notes !== undefined, {
    message: "At least one draft field must be provided."
  });

export const promptTestRunSchema = z.object({
  promptSetName: promptSetNameSchema.optional(),
  promptVersionId: z.number().int().positive().optional(),
  input: z.record(z.any())
});

export const accountRecoveryActionSchema = z.object({
  accountId: z.number().int().positive(),
  publishJobId: z.number().int().positive().optional()
});

export const manualLoginContinueSchema = z.object({
  accountId: z.number().int().positive(),
  publishJobId: z.number().int().positive().optional()
});

export const createJobSchema = z.object({
  accountId: z.number().int().positive()
});

export const createAccountSchema = z.object({
  name: z.string().trim().min(1),
  zhihuUserName: z.union([z.string().trim().min(1), z.null()]).optional(),
  riskDomain: z.union([z.string().trim().min(1), z.null()]).optional()
});

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    zhihuUserName: z.union([z.string().trim().min(1), z.null()]).optional(),
    writerPromptVersionId: z.union([z.number().int().positive(), z.null()]).optional(),
    riskDomain: z.union([z.string().trim().min(1), z.null()]).optional()
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.zhihuUserName !== undefined ||
      value.writerPromptVersionId !== undefined ||
      value.riskDomain !== undefined,
    {
      message: "At least one account field must be provided."
    }
  );

export const saveAccountSoulSchema = z.object({
  coreIdentity: z.string().default(""),
  targetReader: z.string().default(""),
  voiceTraits: z.array(z.string()).default([]),
  worldview: z.array(z.string()).default([]),
  proofAnchors: z.array(z.string()).default([]),
  signatureMoves: z.array(z.string()).default([]),
  productMentionPolicy: z.array(z.string()).default([]),
  hardBoundaries: z.array(z.string()).default([]),
  tabooLexicon: z.array(z.string()).default([]),
  exemplarLines: z.array(z.string()).default([]),
  updateReason: z.string().min(1).default("manual_edit")
});

export const zhihuNoteAgentGenerateSchema = z.object({
  mode: z.literal("zhihu_answer_style_learning"),
  sourceAccount: z.object({
    platform: z.literal("zhihu"),
    handleOrUrl: z.string().trim().min(1)
  }),
  sampleLimit: z.number().int().min(1).max(60).default(35),
  filterConfigVersion: z.string().trim().min(1).default("v1"),
  manualSeedTexts: z.array(z.string().trim().min(1)).optional()
});

const zhihuNoteAgentDocumentReadSchema = z.object({
  path: z.string().trim().min(1),
  label: z.string().trim().min(1),
  exists: z.boolean()
});

const zhihuNoteAgentValidationCheckSchema = z.object({
  label: z.string().trim().min(1),
  passed: z.boolean(),
  severity: z.enum(["error", "warning", "info"]),
  details: z.string()
});

const zhihuNoteAgentPhaseReportSchema = z.object({
  phase: z.enum([
    "collect_source_samples",
    "draft_soul_candidate",
    "apply_soul_candidate"
  ]),
  status: z.enum(["passed", "warning", "failed"]),
  startedAt: z.string().trim().min(1),
  finishedAt: z.string().trim().min(1),
  inputsRead: z.array(zhihuNoteAgentDocumentReadSchema),
  validationChecks: z.array(zhihuNoteAgentValidationCheckSchema),
  diagnostics: z.array(z.string())
});

const zhihuNoteAgentDraftSchema = z.object({
  accountId: z.number().int().positive(),
  accountKey: z.string().trim().min(1),
  matchedBy: z.enum(["accountId", "zhihuUserName", "accountName", "bootstrapped"]).nullable(),
  mode: z.literal("zhihu_answer_style_learning"),
  sourceAccount: z.object({
    platform: z.literal("zhihu"),
    handleOrUrl: z.string().trim().min(1),
    normalizedUserName: z.string().nullable(),
    profileUrl: z.string().nullable()
  }),
  summary: z.string(),
  diagnostics: z.array(z.string()),
  operatorNotes: z.array(z.string()),
  sampleQuality: z.enum(["strong", "ok", "weak", "insufficient"]),
  collectionSummary: z.object({
    requestedSampleSize: z.number().int().min(1),
    fetchedSampleCount: z.number().int().min(0),
    filteredOutCount: z.number().int().min(0),
    keptSampleCount: z.number().int().min(0),
    sampleQuality: z.enum(["strong", "ok", "weak", "insufficient"]),
    sourceHandle: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    collectionSucceeded: z.boolean(),
    browserDiagnostics: z.array(z.string()),
    filterReasonCounts: z.record(z.number().int().min(0))
  }),
  phaseReports: z.array(zhihuNoteAgentPhaseReportSchema),
  soulCandidateMarkdown: z.string(),
  samplePreview: z.array(
    z.object({
      answerUrl: z.string().nullable(),
      questionTitle: z.string(),
      createdAt: z.string().nullable(),
      excerpt: z.string(),
      text: z.string()
    })
  ),
  generatedAt: z.string().trim().min(1),
  sourcePaths: z.object({
    accountMapPath: z.string().trim().min(1),
    noteAgentAssetDir: z.string().trim().min(1),
    soulCandidatePath: z.string().trim().min(1)
  })
});

export const zhihuNoteAgentApplySchema = z.object({
  draft: zhihuNoteAgentDraftSchema,
  actions: z
    .object({
      saveSoulCandidate: z.boolean().optional()
    })
    .optional()
});

export const retryJobSchema = z.object({
  force: z.boolean().default(false)
});

export const reselectTopicSchema = z.object({
  reason: z.string().optional()
});

export const rescheduleJobSchema = z.object({
  scheduledAt: z.string().trim().min(1)
});

const imageAssetTypeSchema = z.enum(["meme", "illustration", "cover", "screenshot", "other"]);
const imagePlatformScopeSchema = z.enum(["zhihu", "x", "both", "unknown"]);
const imageUsageScopeSchema = z.enum(["zhihu_answer", "x_post", "cover", "reaction", "general"]);
const imageRiskLevelSchema = z.enum(["low", "medium", "high", "unknown"]);
const imageAssetStatusSchema = z.enum(["pending_review", "active", "disabled", "rejected"]);
const imageUsageTypeSchema = z.enum(["cover", "body_image", "reaction", "preview"]);
const imageSelectedBySchema = z.enum(["manual", "system"]);
const imageEntityCategorySchema = z.enum(["ip_character", "meme_archetype", "brand_mascot", "public_figure", "other"]);

const imageAnchorKeywordSchema = z.object({
  label: z.string().trim().min(1),
  confidence: z.number().int().min(0).max(100).optional()
});

const imageWeightedTagSchema = z.object({
  label: z.string().trim().min(1),
  confidence: z.number().int().min(0).max(100).optional(),
  importance: z.number().int().min(0).max(100).optional()
});

const imageEmotionTagSchema = z.object({
  label: z.string().trim().min(1),
  confidence: z.number().int().min(0).max(100).optional(),
  intensity: z.number().int().min(0).max(100).optional()
});

const imageEntityTagSchema = z.object({
  name: z.string().trim().min(1),
  category: imageEntityCategorySchema.optional(),
  confidence: z.number().int().min(0).max(100).optional()
});

export const createImageImportJobSchema = z.object({
  sourcePath: z.string().trim().min(1),
  sourceType: z.enum(["directory", "upload"]).default("directory")
});

export const updateImageAssetSchema = z
  .object({
    assetType: imageAssetTypeSchema.optional(),
    platformScope: imagePlatformScopeSchema.optional(),
    usageScope: imageUsageScopeSchema.optional(),
    ocrText: z.union([z.string().trim(), z.literal(""), z.null()]).optional(),
    anchorKeyword: z.union([z.string().trim(), z.literal(""), z.null(), imageAnchorKeywordSchema]).optional(),
    captionShort: z.union([z.string().trim(), z.literal(""), z.null()]).optional(),
    captionLong: z.union([z.string().trim(), z.literal(""), z.null()]).optional(),
    manualCaption: z.union([z.string().trim().min(1), z.literal(""), z.null()]).optional(),
    entityTags: z.array(z.union([z.string().trim().min(1), imageEntityTagSchema])).optional(),
    topicTags: z.array(z.union([z.string().trim().min(1), imageWeightedTagSchema])).optional(),
    emotionTags: z.array(z.union([z.string().trim().min(1), imageEmotionTagSchema])).optional(),
    sceneTags: z.array(z.union([z.string().trim().min(1), imageWeightedTagSchema])).optional(),
    styleTags: z.array(z.union([z.string().trim().min(1), imageWeightedTagSchema])).optional(),
    riskLevel: imageRiskLevelSchema.optional(),
    riskNotes: z.union([z.string(), z.null()]).optional(),
    status: imageAssetStatusSchema.optional(),
    copyrightSource: z.union([z.string(), z.null()]).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one image asset field must be provided."
  });

export const suggestImageAssetsSchema = z.object({
  query: z.string().default(""),
  platform: z.enum(["zhihu", "x"]).optional(),
  assetType: imageAssetTypeSchema.optional(),
  hasText: z.boolean().optional(),
  aspectRatio: z.enum(["landscape", "portrait", "square"]).optional(),
  riskLevel: imageRiskLevelSchema.optional(),
  usageType: imageUsageTypeSchema.optional(),
  contentTitle: z.string().optional(),
  contentText: z.string().optional(),
  preferredTags: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(50).default(12)
});

export const createImageAssetUsageRecordSchema = z.object({
  assetId: z.string().trim().min(1),
  platform: z.enum(["zhihu", "x"]),
  accountId: z.union([z.string().trim().min(1), z.number().int().positive().transform(String), z.null()]).optional(),
  taskId: z.union([z.string().trim().min(1), z.number().int().positive().transform(String), z.null()]).optional(),
  contentId: z.union([z.string().trim().min(1), z.null()]).optional(),
  usageType: imageUsageTypeSchema.default("preview"),
  selectedBy: imageSelectedBySchema.default("manual"),
  note: z.union([z.string(), z.null()]).optional()
});

export const bindJobImageSchema = z.object({
  assetId: z.union([z.string().trim().min(1), z.null()]),
  usageType: imageUsageTypeSchema.default("cover"),
  note: z.union([z.string(), z.null()]).optional()
});

export type CreatePromptDraftInput = z.infer<typeof createPromptDraftSchema>;
export type UpdatePromptDraftInput = z.infer<typeof updatePromptDraftSchema>;
export type PromptTestRunInput = z.infer<typeof promptTestRunSchema>;
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ZhihuNoteAgentGenerateSchemaInput = z.infer<typeof zhihuNoteAgentGenerateSchema>;
export type ZhihuNoteAgentApplySchemaInput = z.infer<typeof zhihuNoteAgentApplySchema>;
export type RetryJobInput = z.infer<typeof retryJobSchema>;
export type ReselectTopicInput = z.infer<typeof reselectTopicSchema>;
export type RescheduleJobInput = z.infer<typeof rescheduleJobSchema>;
export type CreateImageImportJobInput = z.infer<typeof createImageImportJobSchema>;
export type UpdateImageAssetInput = z.infer<typeof updateImageAssetSchema>;
export type SuggestImageAssetsInput = z.infer<typeof suggestImageAssetsSchema>;
export type CreateImageAssetUsageRecordInput = z.infer<typeof createImageAssetUsageRecordSchema>;
export type BindJobImageInput = z.infer<typeof bindJobImageSchema>;
export type ImageModelCenterOverrideInput = z.infer<typeof imageModelCenterOverrideSchema>;
export type ModelCenterAgentOverrideFieldsInput = z.infer<typeof modelCenterAgentOverrideFieldsSchema>;
export type ModelCenterAgentOverrideInput = z.infer<typeof modelCenterAgentOverrideSchema>;
export type ModelCenterSavedModelInput = z.infer<typeof modelCenterSavedModelSchema>;
export type ModelCenterAgentBindingInput = z.infer<typeof modelCenterAgentBindingSchema>;
export type UpdateModelCenterSchemaInput = z.infer<typeof updateModelCenterSchema>;
export type ModelCenterStoredConfigInput = z.infer<typeof modelCenterStoredConfigSchema>;
export type CreateVideoTopicBatchInput = z.infer<typeof createVideoTopicBatchSchema>;
export type RefillVideoTopicBatchInput = z.infer<typeof refillVideoTopicBatchSchema>;
export type VideoHotspotScoreInput = z.infer<typeof videoHotspotScoreSchema>;
export type SaveVideoTopicFeedbackInput = z.infer<typeof saveVideoTopicFeedbackSchema>;
export type CreateVideoProjectInput = z.infer<typeof createVideoProjectSchema>;
export type CreateVideoCaseIntentInput = z.infer<typeof createVideoCaseIntentSchema>;
export type GenerateVideoCaseReviewInput = z.infer<typeof generateVideoCaseReviewSchema>;
export type GenerateVideoScriptInput = z.infer<typeof generateVideoScriptSchema>;
export type SaveVideoScriptPackInput = z.infer<typeof saveVideoScriptPackSchema>;
export type SaveVisualRenderPlanInput = z.infer<typeof saveVisualRenderPlanSchema>;
export type SaveVideoMotionPlanInput = z.infer<typeof saveVideoMotionPlanSchema>;
export type VideoFeedbackDocumentInput = z.infer<typeof videoFeedbackDocumentInputSchema>;
