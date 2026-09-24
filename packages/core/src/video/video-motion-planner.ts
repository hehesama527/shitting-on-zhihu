import {
  videoMotionPlanSchema,
  type VideoAssetSummary,
  type VideoAssetType,
  type VideoMotionConfig,
  type VideoMotionDataBinding,
  type VideoMotionDataRef,
  type VideoMotionQaRule,
  type VideoMotionScene,
  type VideoMotionSceneType,
  type VideoMotionPlan,
  type VideoProjectDetail,
  type VideoProjectSegmentSummary
} from "@zhihu-mvp/shared";

const MOTION_PLAN_VERSION = "motion-plan-v1" as const;
const DEFAULT_MAX_SCENE_DURATION_MS = 12_000;
const TARGET_MICRO_SCENE_MS = 6_000;
const MIN_MICRO_SCENE_MS = 3_000;
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

export type BuildVideoMotionPlanOptions = {
  generatedAt?: string;
  maxSceneDurationMs?: number;
};

export function buildVideoMotionPlan(project: VideoProjectDetail, options: BuildVideoMotionPlanOptions = {}): VideoMotionPlan {
  const maxSceneDurationMs = clamp(
    Math.round(options.maxSceneDurationMs ?? DEFAULT_MAX_SCENE_DURATION_MS),
    MIN_MICRO_SCENE_MS,
    20_000
  );
  const activeAssets = project.assets.filter((asset) => asset.status === "active");
  const scenes: VideoMotionScene[] = [];
  let cursorMs = 0;

  const sortedSegments = [...project.segments].sort((left, right) => left.order - right.order);
  for (const segment of sortedSegments) {
    const voiceAsset = activeAssets.find((asset) => asset.segmentId === segment.id && asset.assetType === "voice");
    const durationMs = Math.max(500, voiceAsset?.durationMs ?? segment.durationSec * 1000);
    const segmentScenes = buildSegmentScenes({
      project,
      segment,
      activeAssets,
      segmentStartMs: cursorMs,
      segmentDurationMs: durationMs,
      maxSceneDurationMs,
      firstSceneOrder: scenes.length + 1
    });
    scenes.push(...segmentScenes);
    cursorMs += durationMs;
  }

  const plan: VideoMotionPlan = {
    version: MOTION_PLAN_VERSION,
    projectId: project.id,
    title: cleanPublicLabel(project.title),
    aspectRatio: "16:9",
    resolution: {
      width: VIDEO_WIDTH,
      height: VIDEO_HEIGHT
    },
    totalDurationMs: cursorMs,
    maxSceneDurationMs,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      planner: "deterministic_v1",
      inputs: buildInputRefs(project)
    },
    dataBindings: buildDataBindings(project),
    scenes,
    qaRules: buildPlanQaRules(),
    notes: [
      "MotionPlan is generated after voice timing so scenes can follow the real audio duration.",
      "Scene templates encode semantic motion intent; renderers should execute these instructions deterministically.",
      "Public overlays are sanitized to avoid internal database, collection, symbol, or agent names."
    ]
  };

  return videoMotionPlanSchema.parse(plan);
}

type BuildSegmentSceneInput = {
  project: VideoProjectDetail;
  segment: VideoProjectSegmentSummary;
  activeAssets: VideoAssetSummary[];
  segmentStartMs: number;
  segmentDurationMs: number;
  maxSceneDurationMs: number;
  firstSceneOrder: number;
};

function buildSegmentScenes(input: BuildSegmentSceneInput): VideoMotionScene[] {
  const clauses = extractClauses(input.segment);
  const sceneCount = pickSceneCount(input.segmentDurationMs, input.maxSceneDurationMs, clauses.length);
  const scenes: VideoMotionScene[] = [];

  for (let index = 0; index < sceneCount; index += 1) {
    const startMs = input.segmentStartMs + Math.floor((input.segmentDurationMs * index) / sceneCount);
    const endMs = input.segmentStartMs + Math.floor((input.segmentDurationMs * (index + 1)) / sceneCount);
    const snippet = pickClauseChunk(clauses, index, sceneCount) || input.segment.subtitle || input.segment.title;
    const sceneType = inferSceneType(snippet, input.segment, index, sceneCount);
    const order = input.firstSceneOrder + index;
    scenes.push({
      sceneId: `${input.segment.segmentKey}-scene-${String(index + 1).padStart(2, "0")}-${sceneType}`,
      segmentId: input.segment.id,
      segmentKey: input.segment.segmentKey,
      order,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      sceneType,
      narrationIntent: buildNarrationIntent(sceneType, snippet),
      dataRef: buildSceneDataRef(input.project, sceneType, input.segment, input.activeAssets),
      visualFocus: buildVisualFocus(sceneType, snippet),
      textOverlays: buildOverlays(input.segment, snippet, sceneType),
      motion: buildMotionConfig(sceneType, index),
      requiredAssetTypes: buildRequiredAssetTypes(sceneType, input.segment.visualBuilder),
      qaRules: buildSceneQaRules(sceneType)
    });
  }

  return scenes;
}

function pickSceneCount(durationMs: number, maxSceneDurationMs: number, clauseCount: number) {
  const countForMaxDuration = Math.max(1, Math.ceil(durationMs / maxSceneDurationMs));
  const countForSemantics = Math.max(1, Math.min(clauseCount, Math.ceil(durationMs / TARGET_MICRO_SCENE_MS)));
  const maxAllowedByMinimumDuration = Math.max(1, Math.ceil(durationMs / MIN_MICRO_SCENE_MS));
  return Math.min(Math.max(countForMaxDuration, countForSemantics), maxAllowedByMinimumDuration);
}

function extractClauses(segment: VideoProjectSegmentSummary) {
  const text = segment.voiceover
    .replace(/\s+/g, " ")
    .replace(/([。！？!?；;])\s+/g, "$1");
  const clauses = text
    .split(/[。！？!?；;]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);
  return clauses.length > 0 ? clauses : [segment.title, segment.subtitle].filter(Boolean);
}

function pickClauseChunk(clauses: string[], index: number, sceneCount: number) {
  if (clauses.length === 0) {
    return "";
  }
  const start = Math.floor((clauses.length * index) / sceneCount);
  const end = Math.max(start + 1, Math.floor((clauses.length * (index + 1)) / sceneCount));
  return clauses.slice(start, end).join("。");
}

function inferSceneType(
  text: string,
  segment: VideoProjectSegmentSummary,
  sceneIndex: number,
  sceneCount: number
): VideoMotionSceneType {
  const haystack = text.trim() || `${segment.title}。${segment.subtitle}`;
  if (sceneIndex === 0 && containsAny(haystack, ["曲线", "误导", "别让", "只看一段", "单一窗口"])) {
    return "hook_curve_warning";
  }
  if (containsAny(haystack, ["均线", "快线", "慢线", "买入", "卖出", "金叉", "死叉", "规则"])) {
    return "ma_crossover_rule";
  }
  if (
    containsAny(haystack, ["三段", "三个窗口", "多段", "跨窗口", "对比"]) ||
    (containsAny(haystack, ["牛市", "熊市", "震荡"]) && containsAny(haystack, ["窗口", "区间", "样本"]))
  ) {
    return "window_comparison";
  }
  if (containsAny(haystack, ["市场环境", "牛市", "熊市", "震荡", "天气"])) {
    return "market_weather";
  }
  if (containsAny(haystack, ["历史数据", "真实数据", "走势", "价格", "K线", "k线", "比特币"])) {
    return "real_market_chart";
  }
  if (containsAny(haystack, ["赚了", "亏了", "上涨", "下跌", "回撤", "130", "45", "收益"])) {
    return "single_window_result";
  }
  if (containsAny(haystack, ["样本", "胜率", "风险", "问题", "失效", "诊断", "复验"])) {
    return "diagnostic_cards";
  }
  if (containsAny(haystack, ["CryptoPathX", "复跑", "记录", "执行", "回测", "产品", "工作流"])) {
    return "product_workflow";
  }
  if (sceneIndex === sceneCount - 1 && containsAny(haystack, ["最后", "总结", "记住", "下一步"])) {
    return "closing_standard";
  }
  return segment.visualBuilder === "gpt_image" ? "image_explainer" : "text_card";
}

function buildNarrationIntent(sceneType: VideoMotionSceneType, snippet: string) {
  const summary = summarizePublicText(snippet, 34);
  const byType: Record<VideoMotionSceneType, string> = {
    hook_curve_warning: "用反直觉开场提醒观众：单一漂亮曲线不代表完整结论。",
    real_market_chart: "把口播里的历史行情说明落到真实走势画面上。",
    ma_crossover_rule: "用动画拆开快慢均线规则，先讲方法再看结果。",
    single_window_result: "展示单个窗口的结果，同时提醒它只是局部样本。",
    window_comparison: "把不同市场窗口并排呈现，让观众看到样本差异。",
    market_weather: "用市场环境分层解释同一规则在不同阶段的表现差异。",
    diagnostic_cards: "把风险、样本、复验结论拆成可扫读的诊断卡片。",
    product_workflow: "把产品能力藏在知识流程里，展示可复验和可追踪。",
    closing_standard: "用收束标准帮助观众记住判断方法。",
    text_card: "用结构化文字卡承接口播要点。",
    image_explainer: "用语义插图辅助解释口播观点。"
  };
  return `${byType[sceneType]} 当前口播重点：${summary}`;
}

function buildSceneDataRef(
  project: VideoProjectDetail,
  sceneType: VideoMotionSceneType,
  segment: VideoProjectSegmentSummary,
  activeAssets: VideoAssetSummary[]
): VideoMotionDataRef {
  const latestCasePack = project.verifiedCasePacks?.[project.verifiedCasePacks.length - 1];
  if (sceneType === "window_comparison" || sceneType === "market_weather") {
    return {
      type: "market_window_comparison",
      key: latestCasePack?.caseId ?? "market_window_comparison",
      source: latestCasePack ? "verified_case_pack.chartData" : "script_segment",
      label: "跨窗口行情对比"
    };
  }
  if (["real_market_chart", "ma_crossover_rule", "single_window_result"].includes(sceneType)) {
    return {
      type: latestCasePack ? "verified_case_pack" : "market_window",
      key: latestCasePack?.caseId ?? `${segment.segmentKey}:market_window`,
      source: latestCasePack ? "verified_case_pack" : "script_segment",
      label: "可复验行情数据"
    };
  }
  const visualAsset = activeAssets.find(
    (asset) => asset.segmentId === segment.id && ["image", "chart", "text_card"].includes(asset.assetType)
  );
  if (visualAsset) {
    return {
      type: "asset",
      key: visualAsset.id,
      source: visualAsset.filePath ?? "video_assets",
      label: "已确认视觉资产"
    };
  }
  return {
    type: "script_segment",
    key: segment.segmentKey,
    source: "video_project_segments",
    label: cleanPublicLabel(segment.title)
  };
}

function buildVisualFocus(sceneType: VideoMotionSceneType, snippet: string) {
  const summary = summarizePublicText(snippet, 28);
  const byType: Record<VideoMotionSceneType, string> = {
    hook_curve_warning: "从一条看似漂亮的收益曲线切入，随后揭示样本窗口问题。",
    real_market_chart: "真实价格路径逐步绘制，关键节点用圆点和标签强调。",
    ma_crossover_rule: "快线、慢线、买入、卖出标记分层出现，避免一次性贴满。",
    single_window_result: "结果数字轻量弹出，旁边保留局部样本提示。",
    window_comparison: "上涨、下跌、震荡三个窗口并排绘制，节奏保持同步。",
    market_weather: "用不同背景区块表示市场环境，再叠加走势和结果。",
    diagnostic_cards: "卡片按口播顺序进入，突出风险和复验动作。",
    product_workflow: "用流程节点展示记录、复跑、对比、沉淀。",
    closing_standard: "用一句标准和三个检查点收束。",
    text_card: "标题和两条要点分层进入。",
    image_explainer: "插图保持轻微景深和局部强调，不做无意义晃动。"
  };
  return `${byType[sceneType]} 画面关键词：${summary}`;
}

function buildOverlays(
  segment: VideoProjectSegmentSummary,
  snippet: string,
  sceneType: VideoMotionSceneType
): VideoMotionScene["textOverlays"] {
  const headline = summarizePublicText(segment.title, 18);
  const callout = summarizePublicText(snippet, 30);
  const overlays: VideoMotionScene["textOverlays"] = [
    {
      text: headline,
      role: "headline",
      position: sceneType === "window_comparison" ? "top_center" : "top_left"
    }
  ];
  if (callout && callout !== headline) {
    overlays.push({
      text: callout,
      role: isRiskScene(sceneType) ? "warning" : "callout",
      position: isChartScene(sceneType) ? "lower_left" : "lower_center"
    });
  }
  if (sceneType === "real_market_chart") {
    overlays.push({
      text: "真实走势逐步绘制",
      role: "caption",
      position: "lower_right"
    });
  }
  if (sceneType === "ma_crossover_rule") {
    overlays.push({
      text: "先定规则，再看结果",
      role: "caption",
      position: "lower_right"
    });
  }
  return overlays;
}

function buildMotionConfig(sceneType: VideoMotionSceneType, sceneIndex: number): VideoMotionConfig {
  if (sceneType === "real_market_chart") {
    return {
      transition: sceneIndex === 0 ? "fade" : "match_cut",
      camera: "track_chart",
      chartDraw: "candlestick_build",
      emphasis: "last_price_dot",
      layerAnimations: ["axis_fade_in", "price_path_draw_continuous", "last_price_pulse"]
    };
  }
  if (sceneType === "ma_crossover_rule") {
    return {
      transition: "match_cut",
      camera: "none",
      chartDraw: "continuous",
      emphasis: "crossover_marker",
      layerAnimations: ["fast_ma_trace", "slow_ma_trace", "signal_markers_stagger"]
    };
  }
  if (sceneType === "window_comparison" || sceneType === "market_weather") {
    return {
      transition: "match_cut",
      camera: "none",
      chartDraw: "line_trace",
      emphasis: "result_delta",
      layerAnimations: ["panels_enter_stagger", "sync_path_draw", "result_badges_pop"]
    };
  }
  if (sceneType === "single_window_result") {
    return {
      transition: "cut",
      camera: "push_in",
      chartDraw: "continuous",
      emphasis: "result_delta",
      layerAnimations: ["window_mask_reveal", "metric_count_up", "sample_warning_fade"]
    };
  }
  if (sceneType === "diagnostic_cards") {
    return {
      transition: "slide",
      camera: "none",
      chartDraw: "none",
      emphasis: "risk_badge",
      layerAnimations: ["cards_enter_by_priority", "risk_badge_pulse"]
    };
  }
  if (sceneType === "product_workflow") {
    return {
      transition: "wipe",
      camera: "none",
      chartDraw: "none",
      emphasis: "workflow_step",
      layerAnimations: ["workflow_nodes_trace", "current_step_highlight"]
    };
  }
  return {
    transition: sceneIndex === 0 ? "fade" : "cut",
    camera: sceneType === "image_explainer" ? "push_in" : "none",
    chartDraw: "none",
    emphasis: sceneType === "hook_curve_warning" ? "risk_badge" : "none",
    layerAnimations: sceneType === "hook_curve_warning" ? ["curve_draw", "sample_window_warning"] : ["text_stagger"]
  };
}

function buildRequiredAssetTypes(sceneType: VideoMotionSceneType, visualBuilder: string | null): VideoAssetType[] {
  const common: VideoAssetType[] = ["voice"];
  if (isChartScene(sceneType)) {
    return [...common, "chart"];
  }
  if (visualBuilder === "gpt_image" || sceneType === "image_explainer") {
    return [...common, "image"];
  }
  return [...common, "text_card"];
}

function buildPlanQaRules(): VideoMotionQaRule[] {
  return [
    {
      ruleId: "horizontal_16_9_only",
      severity: "error",
      description: "MotionPlan MVP must render as horizontal 16:9, default 1920x1080.",
      target: "plan"
    },
    {
      ruleId: "no_long_static_scene",
      severity: "error",
      description: "No generated scene may exceed maxSceneDurationMs; long script segments must be split into micro-scenes.",
      target: "scene"
    },
    {
      ruleId: "voice_timing_first",
      severity: "error",
      description: "Scene timing must be derived after voice duration is known, not from rough script estimates.",
      target: "subtitle"
    },
    {
      ruleId: "semantic_visual_match",
      severity: "warning",
      description: "Chart or image scenes must bind to the spoken semantic intent instead of generic background motion.",
      target: "scene"
    }
  ];
}

function buildSceneQaRules(sceneType: VideoMotionSceneType): VideoMotionQaRule[] {
  if (isChartScene(sceneType)) {
    return [
      {
        ruleId: "chart_data_required",
        severity: "error",
        description: "Chart scenes must bind to verified case data, market window data, or an explicit script data reference.",
        target: "scene"
      },
      {
        ruleId: "smooth_chart_draw",
        severity: "warning",
        description: "Chart drawing should use continuous interpolation and avoid frame-by-frame stepping.",
        target: "scene"
      }
    ];
  }
  if (sceneType === "image_explainer") {
    return [
      {
        ruleId: "image_prompt_semantic_match",
        severity: "warning",
        description: "Generated images must match the narration topic and should be replaced when they feel decorative.",
        target: "asset"
      }
    ];
  }
  return [];
}

function buildDataBindings(project: VideoProjectDetail): VideoMotionDataBinding[] {
  const bindings: VideoMotionDataBinding[] = [];
  for (const pack of project.verifiedCasePacks ?? []) {
    bindings.push({
      key: `verified_case_pack:${pack.caseId}`,
      type: "verified_case_pack",
      source: "video_verified_case_packs.pack_json",
      label: "复验案例证据包",
      required: true,
      fallbackSceneType: "diagnostic_cards",
      notes: `status=${pack.status}`
    });
    if (pack.chartData && Object.keys(pack.chartData).length > 0) {
      bindings.push({
        key: `market_window_comparison:${pack.caseId}`,
        type: "market_window_comparison",
        source: "verified_case_pack.chartData",
        label: "跨窗口行情数据",
        required: true,
        fallbackSceneType: "text_card"
      });
    }
  }
  if (bindings.length === 0) {
    bindings.push({
      key: "script_segments",
      type: "script_segment",
      source: "video_project_segments",
      label: "脚本文案语义",
      required: true,
      fallbackSceneType: "text_card",
      notes: "No verified case pack is attached; chart renderers should require manual data binding before real chart output."
    });
  }
  return bindings;
}

function buildInputRefs(project: VideoProjectDetail) {
  const inputs = ["video_project_segments", "video_assets.voice.duration_ms", "visual_render_plan"];
  if (project.scriptPack) {
    inputs.push("video_projects.script_pack_json");
  }
  if (project.verifiedCasePacks?.length) {
    inputs.push("video_verified_case_packs");
  }
  return inputs;
}

function isChartScene(sceneType: VideoMotionSceneType) {
  return ["real_market_chart", "ma_crossover_rule", "single_window_result", "window_comparison", "market_weather"].includes(
    sceneType
  );
}

function isRiskScene(sceneType: VideoMotionSceneType) {
  return ["hook_curve_warning", "diagnostic_cards", "closing_standard"].includes(sceneType);
}

function containsAny(text: string, needles: string[]) {
  const lower = text.toLowerCase();
  return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

function summarizePublicText(text: string, maxLength: number) {
  const cleaned = cleanPublicLabel(text)
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function cleanPublicLabel(text: string) {
  return text
    .replace(/BTCUSDT(?:_4h)?/gi, "比特币")
    .replace(/crypto_data_new/gi, "复验数据")
    .replace(/MongoDB/gi, "本地复验数据")
    .replace(/VerifiedCasePack/gi, "复验结论")
    .replace(/CaseIntent/gi, "复验请求")
    .replace(/ReviewAgent/gi, "复验审核")
    .replace(/\bcollection\b/gi, "数据来源")
    .replace(/数据库/g, "数据来源")
    .replace(/([+-]?\d+)\.\d+%/g, "$1%左右");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
