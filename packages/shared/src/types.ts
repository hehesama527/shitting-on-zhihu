export type JobStatus =
  | "queued"
  | "topic_discovery"
  | "topic_agent"
  | "topic_review"
  | "writer"
  | "humanizing"
  | "review_hard_gate"
  | "review_editorial"
  | "review_publish"
  | "review_passed"
  | "login_checking"
  | "publishing"
  | "publish_verify"
  | "retry_waiting"
  | "manual_login_required"
  | "needs_manual_review"
  | "published"
  | "failed_terminal";

export type JobStage = JobStatus;

export type JobDisplayStatus =
  | "queued"
  | "reviewing"
  | "needs_manual_review"
  | "ready_to_publish"
  | "publishing"
  | "manual_login_required"
  | "publish_failed"
  | "published";

export type ScheduleSlotStatus =
  | "pending"
  | "in_progress"
  | "published"
  | "failed"
  | "manual_login_required";

export type PromptSetName =
  | "topic_agent"
  | "writer_agent"
  | "review_agent"
  | "publish_agent"
  | "zhihu_note_agent"
  | "x_main_agent"
  | "x_hotspot_scout_agent"
  | "x_research_agent"
  | "x_reference_research_agent"
  | "x_writer_agent"
  | "x_review_agent"
  | "x_publish_agent"
  | "x_traditional_main_agent"
  | "x_traditional_writer_agent"
  | "x_traditional_review_agent"
  | "x_traditional_publish_agent"
  | "x_traditional_note_agent"
  | "video_topic_agent"
  | "video_writer_agent"
  | "video_review_agent"
  | "video_visual_planner"
  | "video_motion_planner"
  | "video_feedback_agent";

export const llmReasoningEfforts = ["low", "medium", "high"] as const;
export type LlmReasoningEffort = (typeof llmReasoningEfforts)[number];

export const llmWireApis = ["responses", "chat_completions"] as const;
export type LlmWireApi = (typeof llmWireApis)[number];

export const modelCenterAgentNames = [
  "topic_agent",
  "writer_agent",
  "review_agent",
  "publish_agent",
  "zhihu_note_agent",
  "x_main_agent",
  "x_hotspot_scout_agent",
  "x_research_agent",
  "x_reference_research_agent",
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
  "video_feedback_agent",
  "ops_agent"
] as const;

export type ModelCenterAgentName = (typeof modelCenterAgentNames)[number];
export type ModelCenterAgentGroup = "zhihu" | "x" | "video" | "system";
export type ModelCenterAgentScope = "zhihu" | "x" | "video" | "ops";

export type ModelCenterGroupDefinition = {
  key: ModelCenterAgentGroup;
  label: string;
  description: string;
};

export const modelCenterGroupDefinitions: ModelCenterGroupDefinition[] = [
  {
    key: "zhihu",
    label: "知乎链路",
    description: "负责选题、写作、审核和发布的知乎生产链路。"
  },
  {
    key: "x",
    label: "X 链路",
    description: "负责研究、写作、审核和发布的 X 独立链路。"
  },
  {
    key: "video",
    label: "Video Hub",
    description: "Platform-neutral video production agents for topics, scripts, visual plans, and feedback."
  },
  {
    key: "system",
    label: "系统协同",
    description: "负责运维诊断与系统级辅助决策。"
  }
];

export type ModelCenterAgentDefinition = {
  name: ModelCenterAgentName;
  label: string;
  shortLabel: string;
  group: ModelCenterAgentGroup;
  scope: ModelCenterAgentScope;
  description: string;
};

export const modelCenterAgentDefinitions: ModelCenterAgentDefinition[] = [
  {
    name: "topic_agent",
    label: "知乎选题代理",
    shortLabel: "选题",
    group: "zhihu",
    scope: "zhihu",
    description: "负责候选问题筛选、风险识别和选题指纹生成。"
  },
  {
    name: "writer_agent",
    label: "知乎写作代理",
    shortLabel: "写作",
    group: "zhihu",
    scope: "zhihu",
    description: "负责知乎正文草稿生成，并驱动后续润色链路。"
  },
  {
    name: "review_agent",
    label: "知乎审核代理",
    shortLabel: "审核",
    group: "zhihu",
    scope: "zhihu",
    description: "负责硬门禁、编辑质量和发布前审核。"
  },
  {
    name: "publish_agent",
    label: "知乎发布代理",
    shortLabel: "发布",
    group: "zhihu",
    scope: "zhihu",
    description: "负责发布动作规划、回退策略和发布校验。"
  },
  {
    name: "zhihu_note_agent",
    label: "Zhihu Note Agent",
    shortLabel: "Note Agent",
    group: "zhihu",
    scope: "zhihu",
    description: "Produces a manually reviewed Soul candidate for the Zhihu chain."
  },
  {
    name: "x_main_agent",
    label: "X 主控代理",
    shortLabel: "主控",
    group: "x",
    scope: "x",
    description: "负责 X 任务总控、是否研究、是否发帖和发布模式决策。"
  },
  {
    name: "x_hotspot_scout_agent",
    label: "X 热点侦察代理",
    shortLabel: "热点侦察",
    group: "x",
    scope: "x",
    description: "负责热点发现、风险识别和任务建议。"
  },
  {
    name: "x_research_agent",
    label: "X 研究代理",
    shortLabel: "研究",
    group: "x",
    scope: "x",
    description: "负责归纳近期市场信息、提炼研究结论，并为后续写作提供研究上下文。"
  },
  {
    name: "x_reference_research_agent",
    label: "X 参考研究代理",
    shortLabel: "参考研究",
    group: "x",
    scope: "x",
    description: "负责抽取参考账号和外部样本的研究素材，补充 X 链路的参考上下文。"
  },
  {
    name: "x_writer_agent",
    label: "X 写作代理",
    shortLabel: "写作",
    group: "x",
    scope: "x",
    description: "负责 X 帖子草稿、线程结构和表达风格输出。"
  },
  {
    name: "x_review_agent",
    label: "X 审核代理",
    shortLabel: "审核",
    group: "x",
    scope: "x",
    description: "负责 X 内容质量审查、风险拦截和修改建议。"
  },
  {
    name: "x_publish_agent",
    label: "X 发布代理",
    shortLabel: "发布",
    group: "x",
    scope: "x",
    description: "负责 X 发布动作选择、发帖策略和发布校验。"
  },
  {
    name: "x_traditional_main_agent",
    label: "X Traditional Main Agent",
    shortLabel: "Traditional Main",
    group: "x",
    scope: "x",
    description: "Selects topics from hotspots, account Soul, and account goals for the traditional X chain."
  },
  {
    name: "x_traditional_writer_agent",
    label: "X Traditional Writer Agent",
    shortLabel: "Traditional Writer",
    group: "x",
    scope: "x",
    description: "Writes drafts with the traditional X chain's own stable writer prompt."
  },
  {
    name: "x_traditional_review_agent",
    label: "X Traditional Review Agent",
    shortLabel: "Traditional Review",
    group: "x",
    scope: "x",
    description: "Reviews traditional X drafts for Soul fit, topic fit, quality, and risk."
  },
  {
    name: "x_traditional_publish_agent",
    label: "X Traditional Publish Agent",
    shortLabel: "Traditional Publish",
    group: "x",
    scope: "x",
    description: "Reserved publish-planning runtime for the traditional X chain."
  },
  {
    name: "x_traditional_note_agent",
    label: "X Traditional Note Agent",
    shortLabel: "Traditional Note",
    group: "x",
    scope: "x",
    description: "Manually fills and updates account-specific RAG rule documents for the traditional X chain."
  },
  {
    name: "video_topic_agent",
    label: "Video Topic Agent",
    shortLabel: "Video Topic",
    group: "video",
    scope: "video",
    description: "Generates weekly video topic candidates and scores hotspot-topic fit."
  },
  {
    name: "video_writer_agent",
    label: "Video Writer Agent",
    shortLabel: "Video Writer",
    group: "video",
    scope: "video",
    description: "Turns selected topics into horizontal video scripts, segments, subtitles, and image prompts."
  },
  {
    name: "video_review_agent",
    label: "Video Review Agent",
    shortLabel: "Evidence Review",
    group: "video",
    scope: "video",
    description: "Reviews real market-data case evidence and produces verified facts, findings, hypotheses, and safety boundaries."
  },
  {
    name: "video_visual_planner",
    label: "Video Visual Planner",
    shortLabel: "Visual Plan",
    group: "video",
    scope: "video",
    description: "Chooses visual builders such as GPT image, Hyperframe, Remotion cards, or existing assets."
  },
  {
    name: "video_motion_planner",
    label: "Video Motion Planner",
    shortLabel: "Motion Plan",
    group: "video",
    scope: "video",
    description: "Turns script, voice timing, verified evidence, and visual assets into reusable motion scenes."
  },
  {
    name: "video_feedback_agent",
    label: "Video Feedback Agent",
    shortLabel: "Feedback",
    group: "video",
    scope: "video",
    description: "Summarizes operator feedback into reusable documents for topic and writing improvement."
  },
  {
    name: "ops_agent",
    label: "运维诊断代理",
    shortLabel: "运维",
    group: "system",
    scope: "ops",
    description: "负责系统故障诊断、根因归纳和处置建议生成。"
  }
];

export type ModelCenterRuntimeEditableConfig = {
  model: string;
  baseUrl: string;
  reasoningEffort: LlmReasoningEffort;
  wireApi: LlmWireApi;
  requestTimeoutMs: number;
};

export type ModelCenterAgentOverrideFields = {
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  reasoningEffort: LlmReasoningEffort | null;
  wireApi: LlmWireApi | null;
  requestTimeoutMs: number | null;
};

export type ModelCenterAgentOverride = {
  agentName: ModelCenterAgentName;
} & ModelCenterAgentOverrideFields;

export type ModelCenterSavedModel = {
  id: string;
  name: string;
  providerLabel: string | null;
  notes: string | null;
  overrides: ModelCenterAgentOverrideFields;
};

export type ModelCenterAgentBinding = {
  agentName: ModelCenterAgentName;
  modelId: string | null;
};

export type ModelCenterFieldSource = "override" | "env" | "codex_config" | "codex_auth" | "default";

export type ModelCenterFieldSources = {
  model: ModelCenterFieldSource;
  baseUrl: ModelCenterFieldSource;
  apiKey: ModelCenterFieldSource;
  reasoningEffort: ModelCenterFieldSource;
  wireApi: ModelCenterFieldSource;
  requestTimeoutMs: ModelCenterFieldSource;
};

export type ImageModelCenterRuntimeConfig = {
  imageAnalysisModel: string;
  imageOcrModel: string;
  imageOcrJudgeModel: string;
  ollamaBaseUrl: string;
  imageAnalysisTimeoutMs: number;
};

export type ImageModelCenterOverrideFields = {
  imageAnalysisModel: string | null;
  imageOcrModel: string | null;
  imageOcrJudgeModel: string | null;
  ollamaBaseUrl: string | null;
  imageAnalysisTimeoutMs: number | null;
};

export type ImageModelCenterFieldSources = {
  imageAnalysisModel: ModelCenterFieldSource;
  imageOcrModel: ModelCenterFieldSource;
  imageOcrJudgeModel: ModelCenterFieldSource;
  ollamaBaseUrl: ModelCenterFieldSource;
  imageAnalysisTimeoutMs: ModelCenterFieldSource;
};

export type ImageModelCenterView = {
  overrides: ImageModelCenterOverrideFields;
  fallbackConfig: ImageModelCenterRuntimeConfig;
  fallbackFieldSources: ImageModelCenterFieldSources;
  effectiveConfig: ImageModelCenterRuntimeConfig;
  fieldSources: ImageModelCenterFieldSources;
};

export type ModelCenterAgentView = {
  agentName: ModelCenterAgentName;
  label: string;
  shortLabel: string;
  group: ModelCenterAgentGroup;
  scope: ModelCenterAgentScope;
  description: string;
  overrides: ModelCenterAgentOverrideFields;
  fallbackConfig: ModelCenterRuntimeEditableConfig;
  fallbackFieldSources: ModelCenterFieldSources;
  effectiveConfig: ModelCenterRuntimeEditableConfig;
  fieldSources: ModelCenterFieldSources;
};

export type ModelCenterView = {
  updatedAt: string | null;
  imageRuntime: ImageModelCenterView;
  models: ModelCenterSavedModel[];
  agentBindings: ModelCenterAgentBinding[];
  agents: ModelCenterAgentView[];
};

export type ModelCenterStoredConfig = {
  version: number;
  updatedAt: string | null;
  imageRuntime: ImageModelCenterOverrideFields;
  models: ModelCenterSavedModel[];
  agentBindings: ModelCenterAgentBinding[];
  agents: ModelCenterAgentOverride[];
};

export type UpdateModelCenterInput = {
  imageRuntime: ImageModelCenterOverrideFields;
  models: ModelCenterSavedModel[];
  agentBindings: ModelCenterAgentBinding[];
  agents?: ModelCenterAgentOverride[];
};

export type VideoTargetPlatform = "agnostic" | "x" | "zhihu" | "douyin" | "xiaohongshu" | "bilibili" | "manual";
export type VideoAspectRatio = "16:9";
export type VideoTopicSource = "weekly" | "hotspot" | "manual" | "platform_request" | "refill";
export type VideoTopicCandidateStatus =
  | "pending_feedback"
  | "selected"
  | "rejected"
  | "deferred"
  | "project_created"
  | "expired";
export type VideoTopicFeedbackDecision = "hit" | "miss" | "not_now" | "duplicate" | "risky";
export type VideoProjectStatus =
  | "topic_selected"
  | "writing"
  | "script_pending_confirmation"
  | "render_plan_pending_confirmation"
  | "script_confirmed"
  | "assets_pending"
  | "voice_rendering"
  | "visual_rendering"
  | "assets_ready"
  | "composing"
  | "video_ready"
  | "video_review_required"
  | "approved"
  | "failed"
  | "archived";
export type VideoSegmentStatus =
  | "planned"
  | "script_ready"
  | "script_confirmed"
  | "voice_pending"
  | "voice_rendering"
  | "voice_ready"
  | "visual_pending"
  | "visual_rendering"
  | "visual_ready"
  | "ready"
  | "failed"
  | "superseded";
export type VideoAssetType =
  | "voice"
  | "image"
  | "chart"
  | "text_card"
  | "subtitle"
  | "video"
  | "composition"
  | "motion_plan";
export type VideoAssetStatus = "pending" | "rendering" | "active" | "superseded" | "failed";
export type VideoRenderBuilder = "gpt_image" | "hyperframe" | "remotion_card" | "existing_asset" | "mixed";
export type VideoTaskKind = "voice" | "visual" | "compose";
export type VideoCaseIntentStatus = "requested" | "evidence_running" | "evidence_ready" | "review_failed" | "abandoned";
export type VideoVerifiedCasePackStatus = "ready" | "ready_with_warnings" | "insufficient_evidence" | "failed";
export type VideoCaseDataSource = "cryptopathx_mongo";
export type VideoCaseStrategyName = "sma_crossover";

export type VideoCaseStrategyConfig = {
  name: VideoCaseStrategyName;
  fastWindow: number;
  slowWindow: number;
  side: "long_only";
};

export type VideoCaseAssumptions = {
  initialCapital: number;
  feeBpsEachSide: number;
  slippageBpsEachSide: number;
};

export type VideoCaseIntentRequest = {
  dataSource?: VideoCaseDataSource;
  symbol: string;
  interval: string;
  startTime: string;
  endTime: string;
  collectionName?: string | null;
  strategy?: Partial<VideoCaseStrategyConfig>;
  assumptions?: Partial<VideoCaseAssumptions>;
  requestedCase?: string;
  notes?: string;
};

export type VideoCaseIntentSummary = {
  id: string;
  projectId: string;
  status: VideoCaseIntentStatus;
  dataSource: VideoCaseDataSource;
  symbol: string;
  interval: string;
  collectionName: string | null;
  startTime: string;
  endTime: string;
  strategyName: VideoCaseStrategyName;
  strategyParams: VideoCaseStrategyConfig;
  assumptions: VideoCaseAssumptions;
  requestJson: Record<string, unknown>;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VideoVerifiedCasePack = {
  caseId: string;
  status: VideoVerifiedCasePackStatus;
  createdAt: string;
  dataSource: Record<string, unknown>;
  caseIntent: Record<string, unknown>;
  strategy: Record<string, unknown>;
  metrics: Record<string, unknown>;
  review: {
    allowedFacts: string[];
    findings: string[];
    hypotheses: string[];
    forbiddenClaims: string[];
    contentSafety: {
      mustSay: string[];
    };
    reviewScore?: number;
    warnings?: string[];
  };
  chartData: Record<string, unknown>;
};

export type VideoVerifiedCasePackSummary = {
  id: string;
  projectId: string;
  caseIntentId: string;
  caseId: string;
  status: VideoVerifiedCasePackStatus;
  dataSource: Record<string, unknown>;
  strategy: Record<string, unknown>;
  metrics: Record<string, unknown>;
  review: VideoVerifiedCasePack["review"];
  chartData: Record<string, unknown>;
  pack: VideoVerifiedCasePack;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VideoTopicCandidateInput = {
  title: string;
  brief: string;
  angle: string;
  videoFormat: "opinion" | "data_explain" | "tutorial" | "case_breakdown" | "product_explain" | "mixed";
  targetAudience: string;
  whyThis: string;
  estimatedDurationSec?: number | null;
  score: number;
  topicFitScore?: number | null;
  productionScore?: number | null;
  scoreBreakdown?: Record<string, number>;
  riskNotes?: string[];
  sourceRefs?: string[];
};

export type VideoTopicBatchOutput = {
  summary: string;
  candidates: VideoTopicCandidateInput[];
};

export type VideoTopicCandidateSummary = VideoTopicCandidateInput & {
  id: string;
  batchId: string;
  source: VideoTopicSource;
  targetPlatform: VideoTargetPlatform;
  status: VideoTopicCandidateStatus;
  createdAt: string;
  updatedAt: string;
  latestFeedbackDecision: VideoTopicFeedbackDecision | null;
};

export type VideoTopicBatchSummary = {
  id: string;
  source: VideoTopicSource;
  status: "pending_feedback" | "completed" | "failed";
  targetPlatform: VideoTargetPlatform;
  targetCount: number;
  generatedCount: number;
  selectedCount: number;
  summary: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VideoScriptSegment = {
  segmentId: string;
  order: number;
  title: string;
  voiceover: string;
  subtitle: string;
  durationSec: number;
  imagePrompt: string;
  visualIntent: string;
  needsChart?: boolean;
  chartSpec?: Record<string, unknown> | null;
};

export type VideoScriptPack = {
  title: string;
  topicId: string;
  aspectRatio: VideoAspectRatio;
  targetDurationSec: number;
  voiceoverFullText: string;
  segments: VideoScriptSegment[];
  coverTitle?: string;
  cta?: string;
  riskNotes?: string[];
};

export type VisualRenderPlanSegment = {
  segmentId: string;
  order: number;
  builder: VideoRenderBuilder;
  reason: string;
  imagePrompt?: string | null;
  chartSpec?: Record<string, unknown> | null;
  cardSpec?: Record<string, unknown> | null;
  existingAssetId?: string | null;
  blockingIssue?: string | null;
};

export type VisualRenderPlan = {
  projectId: string;
  aspectRatio: VideoAspectRatio;
  resolution: {
    width: number;
    height: number;
  };
  segments: VisualRenderPlanSegment[];
  notes?: string[];
};

export type VideoMotionSceneType =
  | "hook_curve_warning"
  | "real_market_chart"
  | "ma_crossover_rule"
  | "single_window_result"
  | "window_comparison"
  | "market_weather"
  | "diagnostic_cards"
  | "product_workflow"
  | "closing_standard"
  | "text_card"
  | "image_explainer";

export type VideoMotionDataRefType =
  | "none"
  | "verified_case_pack"
  | "market_window"
  | "market_window_comparison"
  | "script_segment"
  | "asset";

export type VideoMotionOverlayRole = "headline" | "subhead" | "callout" | "metric" | "warning" | "caption";
export type VideoMotionOverlayPosition =
  | "top_left"
  | "top_center"
  | "top_right"
  | "center"
  | "lower_left"
  | "lower_center"
  | "lower_right";
export type VideoMotionCamera = "none" | "push_in" | "pull_back" | "pan_left" | "pan_right" | "track_chart";
export type VideoMotionTransition = "cut" | "fade" | "match_cut" | "wipe" | "slide";
export type VideoMotionChartDraw = "none" | "continuous" | "candlestick_build" | "line_trace" | "bar_reveal";
export type VideoMotionEmphasis =
  | "none"
  | "last_price_dot"
  | "crossover_marker"
  | "result_delta"
  | "risk_badge"
  | "workflow_step";

export type VideoMotionOverlay = {
  text: string;
  role: VideoMotionOverlayRole;
  position: VideoMotionOverlayPosition;
  startMs?: number;
  endMs?: number;
};

export type VideoMotionDataRef = {
  type: VideoMotionDataRefType;
  key?: string | null;
  source?: string | null;
  label?: string | null;
};

export type VideoMotionConfig = {
  transition: VideoMotionTransition;
  camera: VideoMotionCamera;
  chartDraw: VideoMotionChartDraw;
  emphasis: VideoMotionEmphasis;
  layerAnimations?: string[];
};

export type VideoMotionQaRule = {
  ruleId: string;
  severity: "error" | "warning";
  description: string;
  target: "plan" | "scene" | "asset" | "subtitle";
};

export type VideoMotionDataBinding = {
  key: string;
  type: VideoMotionDataRefType;
  source: string;
  label: string;
  required: boolean;
  fallbackSceneType?: VideoMotionSceneType;
  notes?: string;
};

export type VideoMotionScene = {
  sceneId: string;
  segmentId: string;
  segmentKey: string;
  order: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  sceneType: VideoMotionSceneType;
  narrationIntent: string;
  dataRef: VideoMotionDataRef;
  visualFocus: string;
  textOverlays: VideoMotionOverlay[];
  motion: VideoMotionConfig;
  requiredAssetTypes: VideoAssetType[];
  qaRules: VideoMotionQaRule[];
};

export type VideoMotionPlan = {
  version: "motion-plan-v1";
  projectId: string;
  title: string;
  aspectRatio: VideoAspectRatio;
  resolution: {
    width: number;
    height: number;
  };
  totalDurationMs: number;
  maxSceneDurationMs: number;
  generatedAt: string;
  source: {
    planner: "deterministic_v1" | "agent_refined";
    inputs: string[];
  };
  dataBindings: VideoMotionDataBinding[];
  scenes: VideoMotionScene[];
  qaRules: VideoMotionQaRule[];
  notes: string[];
};

export type VideoProjectSummary = {
  id: string;
  topicCandidateId: string;
  title: string;
  status: VideoProjectStatus;
  targetPlatform: VideoTargetPlatform;
  aspectRatio: VideoAspectRatio;
  targetDurationSec: number | null;
  scriptConfirmedAt: string | null;
  visualRenderPlanConfirmedAt: string | null;
  finalVideoAssetId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VideoProjectSegmentSummary = {
  id: string;
  projectId: string;
  segmentKey: string;
  order: number;
  title: string;
  voiceover: string;
  subtitle: string;
  imagePrompt: string;
  visualBuilder: VideoRenderBuilder | null;
  status: VideoSegmentStatus;
  durationSec: number;
  errorMessage: string | null;
  updatedAt: string;
};

export type VideoAssetSummary = {
  id: string;
  projectId: string;
  segmentId: string | null;
  assetType: VideoAssetType;
  status: VideoAssetStatus;
  builder: VideoRenderBuilder | null;
  filePath: string | null;
  publicUrl: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  attemptNo: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type VideoProjectDetail = VideoProjectSummary & {
  topic: VideoTopicCandidateSummary | null;
  scriptPack: VideoScriptPack | null;
  visualRenderPlan: VisualRenderPlan | null;
  segments: VideoProjectSegmentSummary[];
  assets: VideoAssetSummary[];
  caseIntents?: VideoCaseIntentSummary[];
  verifiedCasePacks?: VideoVerifiedCasePackSummary[];
};

export type VideoFeedbackDocumentSummary = {
  id: string;
  scope: "global" | "topic" | "writer" | "visual" | "project";
  markdown: string;
  summaryJson: Record<string, unknown> | null;
  createdAt: string;
};

export type VideoHubSummary = {
  topicBatches: VideoTopicBatchSummary[];
  candidates: VideoTopicCandidateSummary[];
  projects: VideoProjectSummary[];
  feedbackDocuments: VideoFeedbackDocumentSummary[];
};

export type FailureType =
  | "auth_required"
  | "login_required"
  | "session_expired"
  | "account_identity_mismatch"
  | "challenge_required"
  | "duplicate_block"
  | "editor_not_ready"
  | "submit_not_ready"
  | "network_or_page_error"
  | "publish_uncertain"
  | "content_risk_block"
  | "topic_invalid"
  | "review_block"
  | "llm_connection_error"
  | "unknown_failure";

export type RecoveryAction =
  | "RETRY_SAME_SESSION"
  | "RESTART_BROWSER"
  | "VERIFY_ONCE"
  | "REWRITE_ONCE"
  | "MANUAL_LOGIN"
  | "RESELECT_TOPIC"
  | "TERMINAL_FAIL";

export type ContentQualityDimension =
  | "account_fit"
  | "zhihu_native"
  | "experience_realness"
  | "evidence_density"
  | "structure_naturalness"
  | "ai_smell"
  | "promotion_restraint"
  | "freshness";

export type ContentQualityDimensionScore = {
  score: number;
  issues: string[];
  suggestion: string;
};

export type ManualReviewReason =
  | "low_quality_score"
  | "account_mismatch"
  | "high_ai_smell"
  | "promotion_risk"
  | "weak_evidence"
  | "rewrite_limit_reached";

export type ContentQualityScore = {
  overallScore: number;
  passingScore: number;
  dimensions: Partial<Record<ContentQualityDimension, ContentQualityDimensionScore>>;
  strengths: string[];
  issues: string[];
  rewriteBrief: string;
  manualReviewReasons: ManualReviewReason[];
};

export type SkillName = "humanizer-zh" | "browser-playwright";

export type ToolTraceAction =
  | "open"
  | "snapshot"
  | "click"
  | "focus"
  | "paste_text"
  | "type"
  | "press"
  | "wait"
  | "get_url"
  | "screenshot";

export type ToolTraceStage =
  | "topic_discovery"
  | "login_checking"
  | "publishing"
  | "publish_verify"
  | "manual_login"
  | "unknown";

export type PublishStepAction =
  | "OPEN_PAGE"
  | "CLICK_WRITE_ANSWER"
  | "FOCUS_EDITOR"
  | "PASTE_CONTENT"
  | "CLICK_SUBMIT"
  | "WAIT"
  | "VERIFY_RESULT"
  | "REQUEST_MANUAL_LOGIN";

export type PublishStepPlan = {
  nextAction: PublishStepAction;
  targetTexts: string[];
  targetRoles: Array<"button" | "link">;
  targetSelectors: string[];
  confidence: "high" | "medium" | "low";
  reason: string;
};

export type PromptVersionSummary = {
  id: number;
  setName: PromptSetName;
  version: number;
  status: "draft" | "active" | "archived";
  label: string;
  notes: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type PromptVersionSnapshot = {
  promptSetName: PromptSetName;
  promptVersionId: number | null;
  version: number | null;
  label: string | null;
  content: string;
};

export type PromptSnapshotMap = Partial<Record<PromptSetName, PromptVersionSnapshot>>;

export type PromptSetView = {
  id: number;
  name: PromptSetName;
  title: string;
  activeVersionId: number | null;
  activeContent: string | null;
  versions: PromptVersionSummary[];
  testRuns: PromptTestRunSummary[];
};

export type PromptTestRunSummary = {
  id: number;
  promptVersionId: number;
  createdAt: string;
  inputJson: string;
  outputJson: string | null;
  errorText: string | null;
};

export type ScheduleSlot = {
  id: number;
  accountId: number | null;
  accountName: string | null;
  scheduledAt: string;
  status: ScheduleSlotStatus;
  publishJobId: number | null;
  title: string | null;
  jobStatus?: JobStatus | null;
  jobDisplayStatus?: JobDisplayStatus | null;
  currentStage?: JobStage | null;
};

export type TopicPriority = "P0" | "P1" | "P2" | "SKIP";
export type TopicValidityStatus = "unchecked" | "valid" | "invalid";

export type TopicListItem = {
  id: number;
  questionTitle: string;
  questionUrl: string;
  sourceType: string;
  status: string;
  priority: TopicPriority | null;
  fitScore: number | null;
  questionType: string | null;
  personaMode: string | null;
  mustAvoid: string[];
  riskNotes: string[];
  validityStatus: TopicValidityStatus;
  validityReason: string | null;
  topicSummary: string | null;
  createdAt: string;
};

export type TopicBatchPlanItem = {
  candidateId: number;
  rank: number;
  selectionScore: number;
  selected: boolean;
  reason: string;
  questionTitle: string;
  questionUrl: string;
  sourceType: string;
  priority: TopicPriority | null;
  fitScore: number | null;
  questionType: string | null;
  personaMode: string | null;
};

export type TopicBatchPlan = {
  batchSize: number;
  availableCount: number;
  selectedCandidateId: number | null;
  selectedTitle: string | null;
  summary: string;
  ranking: TopicBatchPlanItem[];
};

export type DraftListItem = {
  id: number;
  topicCardId: number;
  topicCandidateId: number;
  questionTitle: string;
  questionUrl: string;
  rawDraftContent: string | null;
  humanizedContent: string | null;
  approvedContent: string | null;
  reviewStatus: string | null;
  reviewSummary: string | null;
  canPublish: boolean;
  createdAt: string;
};

export type PublishAttemptSummary = {
  id: number;
  publishJobId: number;
  attemptNo: number;
  status: string;
  currentUrl: string | null;
  failureType: FailureType | null;
  failureReason: string | null;
  attemptJson: string;
  createdAt: string;
};

export type ArtifactSummary = {
  id: number;
  publishAttemptId: number | null;
  artifactType: string;
  filePath: string;
  metaJson: string | null;
  createdAt: string;
};

export type ToolTraceSummary = {
  id: number;
  publishJobId: number | null;
  publishAttemptId: number | null;
  traceId: string;
  stage: ToolTraceStage;
  toolName: string;
  action: ToolTraceAction;
  inputJson: string;
  resultJson: string | null;
  artifactPath: string | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
};

export type SkillRunSummary = {
  id: number;
  publishJobId: number | null;
  publishAttemptId: number | null;
  skillName: SkillName;
  agentName: string;
  stage: string | null;
  traceId: string | null;
  inputJson: string;
  outputJson: string | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
  createdAt: string;
};

export type JobListItem = {
  id: number;
  accountId: number;
  topicCardId: number | null;
  reviewId: number | null;
  imageAssetId: string | null;
  status: JobStatus;
  displayStatus: JobDisplayStatus;
  title: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  finalUrl: string | null;
  retryCount: number;
  failureReason: string | null;
  lastErrorType: FailureType | null;
  createdAt: string;
  updatedAt: string;
  scheduleSlotId: number | null;
  scheduleStatus: ScheduleSlotStatus | null;
  currentStage: JobStage | null;
  resumeAnchorJson: string | null;
  promptVersionSnapshotJson: string | null;
  soulVersion: number | null;
  soulMarkdownSnapshot: string | null;
  latestAttemptStatus: string | null;
  latestFailureType: FailureType | null;
  latestScreenshotPath: string | null;
  questionTitle: string | null;
  questionUrl: string | null;
};

export type JobDetail = JobListItem & {
  topicSummary: string | null;
  topicOutputJson: string | null;
  draftContent: string | null;
  humanizedContent: string | null;
  approvedContent: string | null;
  reviewSummary: string | null;
  hardGateJson: string | null;
  editorialReviewJson: string | null;
  publishReviewJson: string | null;
  topicDuplicationJson: string | null;
  contentDuplicationJson: string | null;
};

export type SoulUpdatedBy = "llm" | "user";

export type AccountSoulDocument = {
  accountId: number;
  version: number;
  coreIdentity: string;
  targetReader: string;
  voiceTraits: string[];
  worldview: string[];
  proofAnchors: string[];
  signatureMoves: string[];
  productMentionPolicy: string[];
  hardBoundaries: string[];
  tabooLexicon: string[];
  exemplarLines: string[];
  markdown: string;
  lastUpdatedAt: string;
  updatedBy: SoulUpdatedBy;
  updateReason: string;
  userEditedAt: string | null;
};

export type ZhihuAccountLibraryStage = "writer" | "review";
export type ZhihuAccountLibraryDocType =
  | "style_rules"
  | "answer_structure_rules"
  | "evidence_rules"
  | "review_rubric"
  | "good_answers"
  | "bad_answers"
  | "sample_filter";
export type ZhihuAccountLibraryDocFormat = "markdown" | "jsonl";

export type ZhihuAccountLibraryMapping = {
  accountKey: string;
  enabled: boolean;
  accountIds: number[];
  zhihuUserNames: string[];
  accountNames: string[];
};

export type ZhihuAccountLibraryMap = {
  version: number;
  mappings: ZhihuAccountLibraryMapping[];
};

export type ZhihuAccountLibraryDocumentManifest = {
  id: string;
  type: ZhihuAccountLibraryDocType;
  title: string;
  description: string;
  format: ZhihuAccountLibraryDocFormat;
  path: string;
  enabled: boolean;
  stages: ZhihuAccountLibraryStage[];
  maxItems: number;
};

export type ZhihuAccountLibraryManifest = {
  accountKey: string;
  displayName: string;
  version: number;
  docs: ZhihuAccountLibraryDocumentManifest[];
};

export type ZhihuLearnedSampleRecord = {
  id: string;
  accountKey: string;
  source: "profile_answers";
  sourceAccount: {
    platform: "zhihu";
    handleOrUrl: string;
    normalizedUserName: string | null;
    profileUrl: string | null;
  };
  answerUrl: string | null;
  questionTitle: string;
  questionUrl: string | null;
  createdAt: string | null;
  excerpt: string;
  text: string;
  fingerprint: string;
};

export type ZhihuSampleQuality = "strong" | "ok" | "weak" | "insufficient";
export type ZhihuNoteAgentMode = "zhihu_answer_style_learning";
export type ZhihuNoteAgentPhase =
  | "collect_source_samples"
  | "draft_soul_candidate"
  | "apply_soul_candidate";
export type ZhihuNoteAgentPhaseStatus = "passed" | "warning" | "failed";

export type ZhihuNoteAgentSourceAccountInput = {
  platform: "zhihu";
  handleOrUrl: string;
};

export type ZhihuNoteAgentSourceAccount = ZhihuNoteAgentSourceAccountInput & {
  normalizedUserName: string | null;
  profileUrl: string | null;
};

export type ZhihuNoteAgentDocumentRead = {
  path: string;
  label: string;
  exists: boolean;
};

export type ZhihuNoteAgentValidationCheck = {
  label: string;
  passed: boolean;
  severity: "error" | "warning" | "info";
  details: string;
};

export type ZhihuNoteAgentPhaseReport = {
  phase: ZhihuNoteAgentPhase;
  status: ZhihuNoteAgentPhaseStatus;
  startedAt: string;
  finishedAt: string;
  inputsRead: ZhihuNoteAgentDocumentRead[];
  validationChecks: ZhihuNoteAgentValidationCheck[];
  diagnostics: string[];
};

export type ZhihuNoteAgentCollectionSummary = {
  requestedSampleSize: number;
  fetchedSampleCount: number;
  filteredOutCount: number;
  keptSampleCount: number;
  sampleQuality: ZhihuSampleQuality;
  sourceHandle: string | null;
  sourceUrl: string | null;
  collectionSucceeded: boolean;
  browserDiagnostics: string[];
  filterReasonCounts: Record<string, number>;
};

export type ZhihuNoteAgentSamplePreviewItem = {
  answerUrl: string | null;
  questionTitle: string;
  createdAt: string | null;
  excerpt: string;
  text: string;
};

export type ZhihuNoteAgentSourcePaths = {
  accountMapPath: string;
  noteAgentAssetDir: string;
  soulCandidatePath: string;
};

export type ZhihuNoteAgentGenerateInput = {
  mode: ZhihuNoteAgentMode;
  sourceAccount: ZhihuNoteAgentSourceAccountInput;
  sampleLimit: number;
  filterConfigVersion: string;
  manualSeedTexts?: string[];
};

export type ZhihuNoteAgentDraft = {
  accountId: number;
  accountKey: string;
  matchedBy: "accountId" | "zhihuUserName" | "accountName" | "bootstrapped" | null;
  mode: ZhihuNoteAgentMode;
  sourceAccount: ZhihuNoteAgentSourceAccount;
  summary: string;
  diagnostics: string[];
  operatorNotes: string[];
  sampleQuality: ZhihuSampleQuality;
  collectionSummary: ZhihuNoteAgentCollectionSummary;
  phaseReports: ZhihuNoteAgentPhaseReport[];
  soulCandidateMarkdown: string;
  samplePreview: ZhihuNoteAgentSamplePreviewItem[];
  generatedAt: string;
  sourcePaths: ZhihuNoteAgentSourcePaths;
};

export type ZhihuNoteAgentApplyActions = {
  saveSoulCandidate: boolean;
};

export type ZhihuNoteAgentApplyInput = {
  draft: ZhihuNoteAgentDraft;
  actions?: Partial<ZhihuNoteAgentApplyActions>;
};

export type ZhihuNoteAgentApplyResult = {
  accountId: number;
  accountKey: string;
  appliedAt: string;
  writtenPaths: string[];
  actionsApplied: ZhihuNoteAgentApplyActions;
  phaseReport: ZhihuNoteAgentPhaseReport;
};

export type AccountListItem = {
  id: number;
  name: string;
  zhihuUserName: string | null;
  writerPromptVersionId: number | null;
  status: string;
  statusReason: string | null;
  profileDir: string | null;
  riskDomain: string;
  cooldownUntil: string | null;
  lastRiskAt: string | null;
  lastLoginCheckAt: string | null;
  lastPublishAt: string | null;
};

export type AccountStatusView = {
  id: number;
  name: string;
  zhihuUserName: string | null;
  writerPromptVersionId: number | null;
  status: string;
  statusReason: string | null;
  profileDir: string | null;
  riskDomain: string;
  cooldownUntil: string | null;
  lastRiskAt: string | null;
  lastLoginCheckAt: string | null;
  lastPublishAt: string | null;
  coolingDown: boolean;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  resumeStage: JobStage | null;
  returnUrl: string | null;
  expectedProfileDir: string | null;
  profileDirWarning: string | null;
  blockedJobs: JobListItem[];
};

export type DashboardSummary = {
  account: AccountStatusView | null;
  todaySchedule: ScheduleSlot[];
  weekSchedule: ScheduleSlot[];
  recentJobs: JobListItem[];
  recentTopics: TopicListItem[];
  metrics: {
    totalJobs: number;
    publishedJobs: number;
    manualLoginJobs: number;
    failedJobs: number;
    readyToPublishJobs: number;
  };
};

export type WorkerTickSummary = {
  generatedSlots: number;
  harvestedCandidates: number;
  preparedJobs: number;
  inFlightPrepareJobs?: number;
  processedJobs: number;
  blockedByLogin: boolean;
  accountStatus: string;
  message: string | null;
};

export type OpsIncidentSeverity = "critical" | "high" | "medium" | "low";

export type OpsIncidentStatus = "open" | "resolved";

export type OpsIncidentSource =
  | "worker_job"
  | "manual_login"
  | "worker_runtime"
  | "api_health"
  | "pm2_scan"
  | "log_scan"
  | "publish_attempt_scan"
  | "schedule_scan";

export type OpsIncidentNotificationDelivery = "sent" | "disabled" | "failed";

export type OpsIncidentSummary = {
  id: number;
  fingerprint: string;
  source: OpsIncidentSource;
  severity: OpsIncidentSeverity;
  status: OpsIncidentStatus;
  serviceName: string;
  accountId: number | null;
  jobId: number | null;
  failureType: string | null;
  title: string;
  diagnosisSummary: string | null;
  rootCause: string | null;
  suggestedAction: string | null;
  rawErrorExcerpt: string | null;
  notificationDelivery: OpsIncidentNotificationDelivery | null;
  notificationMessage: string | null;
  notifiedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OpsIncidentDetail = OpsIncidentSummary & {
  evidenceJson: string | null;
};

export type OpsScanSummary = {
  scannedAt: string;
  createdCount: number;
  dedupedCount: number;
  notifiedCount: number;
  resolvedCount: number;
  openCount: number;
};

export type OpsSummary = {
  openCount: number;
  criticalCount: number;
  highCount: number;
  recentIncidents: OpsIncidentSummary[];
};

export type ImageAssetType = "meme" | "illustration" | "cover" | "screenshot" | "other";
export type ImageSourceType = "upload" | "local_import";
export type ImagePlatformScope = "zhihu" | "x" | "both" | "unknown";
export type ImageUsageScope = "zhihu_answer" | "x_post" | "cover" | "reaction" | "general";
export type ImageAspectRatio = "landscape" | "portrait" | "square";
export type ImageRiskLevel = "low" | "medium" | "high" | "unknown";
export type ImageAnalysisStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type ImageAssetStatus = "pending_review" | "active" | "disabled" | "rejected";
export type ImageImportJobStatus = "pending" | "running" | "completed" | "failed";
export type ImageUsageType = "cover" | "body_image" | "reaction" | "preview";
export type ImageSelectedBy = "manual" | "system";
export type ImageEntityCategory = "ip_character" | "meme_archetype" | "brand_mascot" | "public_figure" | "other";

export type ImageAnchorKeyword = {
  label: string;
  confidence: number;
};

export type ImageWeightedTag = {
  label: string;
  confidence: number;
  importance: number;
};

export type ImageEmotionTag = {
  label: string;
  confidence: number;
  intensity: number;
};

export type ImageEntityTag = {
  name: string;
  category: ImageEntityCategory;
  confidence: number;
};

export type ImageAnalysisSuggestion = {
  ocrText: string;
  caption: string;
  captionShort: string;
  captionLong: string;
  anchorKeyword: ImageAnchorKeyword | null;
  assetType: ImageAssetType;
  platformScope: ImagePlatformScope;
  usageScope: ImageUsageScope;
  hasText: boolean;
  entityTags: ImageEntityTag[];
  primaryTopic: ImageWeightedTag | null;
  topicTags: ImageWeightedTag[];
  primaryEmotion: ImageEmotionTag | null;
  emotionTags: ImageEmotionTag[];
  sceneTags: ImageWeightedTag[];
  styleTags: ImageWeightedTag[];
  riskLevel: ImageRiskLevel;
  riskNotes: string;
};

export type ImageAssetSummary = {
  id: string;
  assetType: ImageAssetType;
  sourceType: ImageSourceType;
  fileName: string;
  sourcePath: string | null;
  storagePath: string;
  storageUrl: string;
  thumbnailPath: string | null;
  thumbnailUrl: string | null;
  fileHash: string;
  mimeType: string;
  fileSize: number;
  width: number | null;
  height: number | null;
  aspectRatio: ImageAspectRatio;
  platformScope: ImagePlatformScope;
  usageScope: ImageUsageScope;
  hasText: boolean;
  ocrText: string | null;
  anchorKeyword: string | null;
  captionShort: string | null;
  captionLong: string | null;
  autoCaption: string | null;
  manualCaption: string | null;
  entityTags: ImageEntityTag[];
  primaryTopic: ImageWeightedTag | null;
  primaryEmotion: ImageEmotionTag | null;
  topicTags: ImageWeightedTag[];
  emotionTags: ImageEmotionTag[];
  sceneTags: ImageWeightedTag[];
  styleTags: ImageWeightedTag[];
  riskLevel: ImageRiskLevel;
  riskNotes: string | null;
  copyrightSource: string | null;
  analysisStatus: ImageAnalysisStatus;
  analysisError: string | null;
  status: ImageAssetStatus;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ImageAssetDetail = ImageAssetSummary & {
  analysisSuggestion: ImageAnalysisSuggestion | null;
  manualOverrideFields: string[];
};

export type ImageImportJobSummary = {
  id: string;
  sourceType: "upload" | "directory";
  sourcePath: string;
  status: ImageImportJobStatus;
  totalCount: number;
  importedCount: number;
  duplicatedCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ImageAssetUsageRecord = {
  id: string;
  assetId: string;
  platform: "zhihu" | "x";
  accountId: string | null;
  taskId: string | null;
  contentId: string | null;
  usageType: ImageUsageType;
  selectedBy: ImageSelectedBy;
  note: string | null;
  createdAt: string;
  asset: Pick<
    ImageAssetSummary,
    | "id"
    | "fileName"
    | "assetType"
    | "platformScope"
    | "status"
    | "riskLevel"
    | "thumbnailUrl"
    | "thumbnailPath"
    | "manualCaption"
    | "autoCaption"
  > | null;
};

export type ImageSearchFilters = {
  query: string;
  anchorKeyword?: string;
  entity?: string;
  platformScope?: ImagePlatformScope | "all";
  assetType?: ImageAssetType | "all";
  usageScope?: ImageUsageScope | "all";
  hasText?: "all" | "yes" | "no";
  aspectRatio?: ImageAspectRatio | "all";
  riskLevel?: ImageRiskLevel | "all";
  status?: ImageAssetStatus | "all";
  limit?: number;
};

export type ImageAssetCandidate = {
  asset: ImageAssetSummary;
  score: number;
  hitReasons: string[];
};

export type ImageAnalysisRuntimeAsset = Pick<
  ImageAssetSummary,
  "id" | "fileName" | "sourcePath" | "thumbnailUrl" | "analysisStatus" | "status"
>;

export type ImageAnalysisQueueSnapshot = {
  currentAsset: ImageAnalysisRuntimeAsset | null;
  currentStageLabel: string | null;
  currentStep: number;
  totalSteps: number;
  currentProgressPercent: number;
  queuedCount: number;
  runningCount: number;
  pendingCount: number;
  concurrency: number;
  currentStartedAt: string | null;
};

export type ScrapedContentType = "answer" | "article" | "pin";
export type ScrapedContentStatus = "pending" | "used" | "rejected";

export type ZhihuScrapedContent = {
  id: number;
  sourceAccount: string;
  contentType: ScrapedContentType;
  contentId: string;
  questionTitle: string | null;
  questionUrl: string | null;
  contentText: string | null;
  contentHtml: string | null;
  voteCount: number;
  commentCount: number;
  createdAt: string | null;
  scrapedAt: string;
  contentHash: string;
  status: ScrapedContentStatus;
};

export type ImageAssetReanalyzeProgress = {
  id: string | null;
  status: "idle" | "running" | "paused" | "completed";
  pauseRequested: boolean;
  scopeStatus: ImageAssetStatus | "all";
  requestedCount: number;
  completedCount: number;
  failedCount: number;
  remainingCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  currentAsset: ImageAnalysisRuntimeAsset | null;
  queue: ImageAnalysisQueueSnapshot;
};
