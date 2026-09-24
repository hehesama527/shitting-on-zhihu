import type {
  ContentQualityDimension,
  ContentQualityDimensionScore,
  ContentQualityScore,
  ManualReviewReason,
  PromptSnapshotMap
} from "@zhihu-mvp/shared";
import {
  buildReviewSoulPromptSuffix,
  buildReviewTargetProductPromptSuffix,
  joinPromptSuffixes
} from "./account-prompt-context.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { LlmService } from "./llm-service.js";
import { type ZhihuAgentContextDocuments, ZhihuAgentContextService } from "./zhihu-agent-context-service.js";

export type ReviewStageResult = {
  decision: "PASS" | "REVISE" | "BLOCK" | "BLOCK_DUPLICATION";
  issues: string[];
  reason?: string;
  score?: number;
  strengths?: string[];
  rewrite_brief?: string;
  publish_ready?: boolean;
  duplicate_reason?: string;
  matched_past_contents?: string[];
  review_summary?: string;
  approved_content?: string;
  quality?: Partial<ContentQualityScore> | null;
};

export type ReviewResult = {
  decision: "PASS" | "REVISE" | "BLOCK" | "BLOCK_DUPLICATION";
  hardGate: ReviewStageResult;
  editorial: ReviewStageResult;
  publish: ReviewStageResult;
  quality: ContentQualityScore;
  reviewSummary: string;
  approvedContent: string | null;
};

export type CombinedReviewOutput = {
  hardGate?: Partial<ReviewStageResult> | null;
  editorial?: Partial<ReviewStageResult> | null;
  publish?: Partial<ReviewStageResult> | null;
};

export class ReviewService {
  private readonly agentContextService = new ZhihuAgentContextService();

  constructor(private readonly llmService: LlmService) {}

  async reviewContent(
    input: {
      content: string;
      topicSummary: string;
      topicCard?: Record<string, unknown> | null;
      softPromoDirective?: Record<string, unknown> | null;
      pastContentFingerprints: unknown[];
    },
    promptSnapshot?: PromptSnapshotMap | null,
    hooks?: {
      accountSoulMarkdown?: string | null;
      agentContextDocuments?: ZhihuAgentContextDocuments | null;
      onStage?: (stage: "review_hard_gate" | "review_editorial" | "review_publish") => Promise<void> | void;
    }
  ): Promise<ReviewResult> {
    const startedAt = Date.now();
    logDebugTiming("review.reviewContent", "start", {
      contentLength: input.content.length,
      pastContentFingerprints: input.pastContentFingerprints.length
    });
    await hooks?.onStage?.("review_hard_gate");
    const softPromoDirective = resolveSoftPromoDirective(input.softPromoDirective ?? input.topicCard ?? null);

    const reviewPrompt = await this.llmService.resolvePrompt("review_agent", {
      promptSnapshot
    });
    const agentContextDocuments =
      hooks?.agentContextDocuments ?? (await this.agentContextService.ensureDocuments());

    const combined = await this.llmService.runJsonWithSystemPrompt<CombinedReviewOutput>(
      buildCombinedReviewPrompt(
        reviewPrompt,
        hooks?.accountSoulMarkdown,
        softPromoDirective,
        agentContextDocuments,
        input.topicCard && typeof input.topicCard === "object"
          ? (input.topicCard as Record<string, unknown>).writing_plan
          : null,
        input.topicCard && typeof input.topicCard === "object"
          ? (input.topicCard as Record<string, unknown>).case_research
          : null
      ),
      {
        ...input,
        softPromoDirective
      },
      {
        hardGate: buildHardGateFallback(),
        editorial: buildEditorialFallback(),
        publish: buildPublishFallback(input.content)
      }
    );

    await hooks?.onStage?.("review_editorial");
    await hooks?.onStage?.("review_publish");

    const editorial = normalizeEditorial(combined.editorial);
    const publish = normalizePublish(combined.publish, input.content);
    const hardGate = applyForbiddenRelayDomainHardGate(
      normalizeHardGate(combined.hardGate),
      input.content,
      publish.approved_content
    );
    const quality = normalizeContentQuality(editorial.quality, editorial, publish);

    if (hardGate.decision === "BLOCK") {
      logDebugTiming("review.reviewContent", "hard_block", {
        elapsedMs: getElapsedMs(startedAt),
        reason: hardGate.reason ?? "Hard gate blocked the draft."
      });
      return {
        decision: "BLOCK",
        hardGate,
        editorial,
        publish,
        quality,
        reviewSummary: hardGate.reason ?? "Hard gate blocked the draft.",
        approvedContent: null
      };
    }

    const finalDecision: ReviewResult["decision"] =
      publish.decision === "BLOCK_DUPLICATION"
        ? "BLOCK_DUPLICATION"
        : editorial.decision === "REVISE" || publish.decision === "REVISE" || quality.manualReviewReasons.length > 0
          ? "REVISE"
          : "PASS";

    logDebugTiming("review.reviewContent", "done", {
      elapsedMs: getElapsedMs(startedAt),
      decision: finalDecision
    });

    return {
      decision: finalDecision,
      hardGate,
      editorial,
      publish,
      quality,
      reviewSummary: publish.review_summary ?? quality.rewriteBrief ?? editorial.rewrite_brief ?? hardGate.reason ?? "",
      approvedContent: finalDecision === "PASS" ? publish.approved_content ?? input.content : null
    };
  }
}

function buildCombinedReviewPrompt(
  reviewPrompt: string,
  accountSoulMarkdown?: string | null,
  softPromoDirective?: SoftPromoReviewDirective,
  agentContextDocuments?: ZhihuAgentContextDocuments | null,
  writingPlan?: unknown,
  caseResearch?: unknown
) {
  return `${joinPromptSuffixes(
    reviewPrompt,
    buildReviewTargetProductPromptSuffix(agentContextDocuments),
    buildReviewSoulPromptSuffix(accountSoulMarkdown),
    buildReviewWritingPlanPromptSuffix(writingPlan),
    buildReviewCaseResearchPromptSuffix(caseResearch),
    buildReviewSoftPromoPromptSuffix(softPromoDirective)
  )}

Additional instructions:
你正在做发布前的合并审核，必须正好返回三个部分：
1. hardGate
2. editorial
3. publish

输出约定：
1. hardGate.decision 只能是 PASS 或 BLOCK。
2. editorial.decision 只能是 PASS 或 REVISE。
3. publish.decision 只能是 PASS、REVISE 或 BLOCK_DUPLICATION。
4. 只有 publish.decision = PASS 时，publish.approved_content 才能放最终可发布正文。
5. 某一层没有问题时，issues 返回空数组。
6. 不要再返回第四个顶层最终决策。只返回这三个对象。
7. 只输出 JSON。不要 Markdown。JSON 外不要解释。
8. editorial.quality 要打分：这篇像不像知乎原生回答、像不像这个账号、够不够具体、有没有证据、够不够克制、AI 味低不低。

${buildAiAuthenticityReviewPromptSuffix()}

重复审核要故意放宽。
目标不是逼每篇文章听起来像换了一个人写的。
真正要拦的，只是新文章读起来像最近某篇的换皮重写。

对照最近 10 篇已发布内容查重复时：
1. 共用同一个人设、同一个产品、同一类读者、同一套产品能力和同一套品牌语气，都是正常的。单凭这些不要判重复。
2. 类似的产品提及、类似的软广逻辑、类似的风险提醒，或重复一个比喻，都不够构成 BLOCK_DUPLICATION。
3. 如果文章仍有新价值、新框架、不同问题入口、明显不同的论证路径，或不同的可操作结论，优先 PASS。
4. 如果文章有用，但部分段落和旧文太近，优先 REVISE，不要直接 BLOCK_DUPLICATION。
5. 只有整体阅读体验强烈像同一篇文章重写时，才用 BLOCK_DUPLICATION：
   同一套开头角度、
   同一套核心论证路径、
   同一套案例结构、
   同一套操作建议顺序、
   同一套收口推销，
   普通读者会觉得这基本上是一篇回收回答。
6. 不要只因为两篇都用类似方式推广同一个产品，就判重复。

Output schema:
{
  "hardGate": {
    "decision": "PASS | BLOCK",
    "issues": ["issue 1"],
    "reason": "one-sentence reason"
  },
  "editorial": {
    "decision": "PASS | REVISE",
    "issues": ["issue 1"],
    "score": 0,
    "strengths": ["strength 1"],
    "rewrite_brief": "clear rewrite instructions",
    "quality": {
      "overallScore": 78,
      "passingScore": 72,
      "dimensions": {
        "account_fit": { "score": 80, "issues": [], "suggestion": "" },
        "zhihu_native": { "score": 80, "issues": [], "suggestion": "" },
        "experience_realness": { "score": 80, "issues": [], "suggestion": "" },
        "evidence_density": { "score": 80, "issues": [], "suggestion": "" },
        "structure_naturalness": { "score": 80, "issues": [], "suggestion": "" },
        "ai_smell": { "score": 80, "issues": [], "suggestion": "" },
        "promotion_restraint": { "score": 80, "issues": [], "suggestion": "" },
        "freshness": { "score": 80, "issues": [], "suggestion": "" }
      },
      "strengths": ["strength 1"],
      "issues": ["issue 1"],
      "rewriteBrief": "clear rewrite instructions",
      "manualReviewReasons": []
    }
  },
  "publish": {
    "decision": "PASS | REVISE | BLOCK_DUPLICATION",
    "issues": ["issue 1"],
    "publish_ready": true,
    "duplicate_reason": "",
    "matched_past_contents": [],
    "review_summary": "short summary",
    "approved_content": "final publishable article"
  }
}`;
}

function buildAiAuthenticityReviewPromptSuffix() {
  return USE_COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_ROLLBACK
    ? COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_ROLLBACK
    : COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_V1;
}

const USE_COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_ROLLBACK = false;
const COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_ROLLBACK = "";

const COMBINED_REVIEW_AI_AUTHENTICITY_PROMPT_V1 = `AI 痕迹审核：
这是审核 Agent 内部的提示信号，不是单独的通过门槛。
判断这篇草稿读起来更像 AI 生成，还是像 AI 拟人化处理后的文字。不要断言作者身份，只判断读者会不会觉得假。

检查这些信号：
1. 论证过于完整、过于顺滑。
2. 模板化开头、万能结尾，或标准三段论推进。
3. 有亲身经历口吻，却没有具体场景支撑，例如空泛的“以前我也……”“以我的经验……”。
4. 数字、案例、判断堆得很密，但来源边界不清楚。
5. 案例过于工整，不像自然观察到的，也没有标明是复合案例。
6. 产品插入过于顺、过于计划，读起来像软广桥段，而不像工作流里的一步。
7. 段落节奏过于稳定，每段都是观点 + 解释 + 总结。
8. 刻意很冲的观点、刻意口语，或“资深接入顾问”腔显得像在演戏。
9. 结尾金句打磨过度、口号式升华，或收得过于整齐。
10. 通用 AI 填料：因此/同时/总体来看、模糊权威归因、抽象名词过多、没必要的三要点列表。
11. 长文里反复用同一套语气，尤其是每一段都同样光滑、同样完整。
12. 假装很有经验，却没有留下一两处真人通常会留下的、不完美的具体细节。

editorial.quality.dimensions.ai_smell.score 打分：
85-100：几乎看不出明显 AI 写作风险。
70-84：有一点 AI 味；其他维度过关就可以发。
55-69：中等 AI 味；给出局部改写建议，并明确标出可疑段落。
40-54：AI 味明显；要求 REVISE，并指出该改哪些段。
0-39：高度模板化或合成感；不大幅改写不能发。

敏感度规则：
1. 上面清单里出现 3 个及以上具体信号时，ai_smell 不要高于 69。
2. 出现 5 个及以上信号，或有一个很强的扮演人设信号时，ai_smell 打到 55 以下；除非有非常扎实的具体细节明显压过这个模式。
3. 写得漂亮的长文不等于 AI 写的；但如果大部分段落都一样光滑，又没有任何毛边，打分不要过于保守。

AI 味反馈要求：
1. 具体发现放进 editorial.quality.dimensions.ai_smell.issues。
2. 可执行的改写方向放进 editorial.quality.dimensions.ai_smell.suggestion。
3. 如果 AI 味构成修改理由，把同样的具体证据写进 editorial.rewrite_brief 和 editorial.quality.rewriteBrief，方便写作 Agent 按现有审核-改写循环修改。
4. 引用或概括可疑原句/原段。不要写“再自然一点”这种空反馈。
5. 证据弱时，保持 ai_smell.score >= 70，不要只因为 AI 味就强制 REVISE。
6. 只有多个具体信号，或一个会让普通知乎读者觉得这篇是合成文的严重信号时，才打到 55 以下。
7. 如果结构扎实但仍过光滑，点出最像在演戏的那几段，不要给空泛的全局评价。

反馈示例：
1. “以前我也这样，后来学着先看账单”有亲身经历口吻，但没有具体场景或动作细节，像拟人化模板。请写作 Agent 补一个具体操作细节，或改成对读者的一般观察。
2. “Dudu 中转站”连续两段出现，过渡过于顺滑，产品提及像提前安排好的。请写作 Agent 只保留一次产品提及，另一次改成“中转方案”或具体工作流步骤。
3. 结尾句过于打磨、像口号。请写作 Agent 改成克制的动作边界，或一个具体风险提醒。`;

type SoftPromoReviewDirective = {
  shouldInclude: boolean;
  mode: string;
  reason: string;
  productAnchor: string;
  writerInstruction: string;
};

function resolveSoftPromoDirective(value: unknown): SoftPromoReviewDirective {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const nested =
    record.soft_promo_directive && typeof record.soft_promo_directive === "object"
      ? (record.soft_promo_directive as Record<string, unknown>)
      : record;
  const rawMode =
    nested.mode === "light" || nested.mode === "natural" || nested.mode === "none"
      ? nested.mode
      : record.soft_promo_mode === "light" || record.soft_promo_mode === "natural" || record.soft_promo_mode === "none"
        ? String(record.soft_promo_mode)
        : "none";
  const shouldInclude =
    typeof nested.should_include === "boolean"
      ? nested.should_include
      : typeof record.should_include_soft_promo === "boolean"
        ? record.should_include_soft_promo
        : rawMode === "light" || rawMode === "natural";
  const topicFingerprint =
    record.topic_fingerprint && typeof record.topic_fingerprint === "object"
      ? (record.topic_fingerprint as Record<string, unknown>)
      : {};

  return {
    shouldInclude,
    mode: shouldInclude ? (rawMode === "none" ? "light" : rawMode) : "none",
    reason: pickNonEmptyString(nested.reason, record.soft_promo_reason),
    productAnchor: shouldInclude ? pickNonEmptyString(nested.product_anchor, topicFingerprint.promo_entry) : "",
    writerInstruction: pickNonEmptyString(nested.writer_instruction)
  };
}

function buildReviewSoftPromoPromptSuffix(directive?: SoftPromoReviewDirective) {
  const resolved = directive ?? resolveSoftPromoDirective(null);
  if (resolved.shouldInclude) {
    return [
      "软广审核规则：",
      "1. 这道已选题要不要软广，以选题 Agent 为准。",
      "2. 选题 Agent 标记 include_soft_promo=true，所以要检查草稿有没有把 Dudu 中转站自然放进具体、不夸大的位置。",
      "3. 如果完全没有 Dudu 中转站或短称 Dudu，editorial.decision 通常应为 REVISE，并在 rewrite_brief 里简洁要求写作 Agent 在选定的产品承接点自然补上。",
      "4. 如果出现了产品名，但读起来像硬广、功能清单、保证话术或无关插入，要求修改。",
      "5. 正文出现 api.dududu.cloud 或 dududu.cloud 时，hardGate 必须 BLOCK。提到 Dudu 时，必须有一句 **加粗** 引导点名文末 GitHub 仓库 「router-list」 并写清打开后看什么；文末「参考文献」只放 https://github.com/hehesama527/router-list ，链接上方要有加粗说明。缺少引导或引导未加粗时要求 REVISE。这段参考文献不算结尾硬广。",
      `6. 选题原因：${resolved.reason || "未提供"}`,
      resolved.productAnchor ? `7. 产品承接点：${resolved.productAnchor}` : null,
      resolved.writerInstruction ? `8. 给写作 Agent 的指令：${resolved.writerInstruction}` : null
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "软广审核规则：",
    "1. 这道已选题要不要软广，以选题 Agent 为准。",
    "2. 选题 Agent 标记 include_soft_promo=false，所以不要只因为没有 Dudu 中转站就要求修改。",
    "3. 对这道题来说，答案有用且切题时，不提产品是可以接受的。",
    "4. 如果草稿在 include_soft_promo=false 时仍加了 Dudu 中转站，只有提及不自然、有风险、夸大，或抢走回答重心时，才标记。",
    "5. 即使这道题不要求软广，正文出现 api.dududu.cloud 或 dududu.cloud 时，hardGate 仍必须 BLOCK。",
    `6. 选题原因：${resolved.reason || "未提供"}`,
    resolved.writerInstruction ? `7. 给写作 Agent 的指令：${resolved.writerInstruction}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReviewCaseResearchPromptSuffix(caseResearch?: unknown) {
  const record = caseResearch && typeof caseResearch === "object" ? (caseResearch as Record<string, unknown>) : null;
  if (!record) {
    return "";
  }

  const materials = Array.isArray(record.case_materials)
    ? record.case_materials
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 4)
    : [];

  return [
    "后端 case_research 审核规则：",
    `1. should_use_case_research: ${record.should_use_case_research === true}`,
    typeof record.research_summary === "string" && record.research_summary.trim()
      ? `2. research_summary: ${record.research_summary.trim()}`
      : null,
    materials.length
      ? `3. case_materials: ${JSON.stringify(
          materials.map((item) => ({
            case_label: item.case_label,
            source_type: item.source_type,
            source_label: item.source_label,
            time_or_period: item.time_or_period,
            price_or_market_path: item.price_or_market_path,
            retail_entry_trigger: item.retail_entry_trigger,
            risk_mechanism: item.risk_mechanism,
            outcome_pressure: item.outcome_pressure,
            confidence: item.confidence,
            caution: item.caution
          }))
        )}`
      : "3. case_materials: []",
    "4. 如果写作计划要求案例，而且后端 case_research 有用，草稿却无视它、继续空泛写，又没有安全理由，要求修改。",
    "5. 如果某条案例材料是低置信度，或 source_type=composite_hint，写作 Agent 不能把它写成已验证真实事件、真实朋友故事或精确个人记录。",
    "6. 不要要求最终回答里必须放来源链接；判断文章有没有谨慎、具体地用这些材料。",
    "7. 如果草稿抄了来源/参考原文，或反复复用一个旧的用户案例，而后端 case_research 还有其他可用材料，要求修改。"
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReviewWritingPlanPromptSuffix(value: unknown) {
  const plan = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!plan) {
    return null;
  }

  const lengthMode = typeof plan.length_mode === "string" ? plan.length_mode : "standard";
  const targetMin = Number.isFinite(Number(plan.target_words_min)) ? Number(plan.target_words_min) : 0;
  const targetMax = Number.isFinite(Number(plan.target_words_max)) ? Number(plan.target_words_max) : 0;
  const structureMode = typeof plan.structure_mode === "string" ? plan.structure_mode : "";
  const shouldUseCases = plan.should_use_cases === true;
  const caseStyle = typeof plan.case_style === "string" ? plan.case_style : "none";
  const shouldIncludeCalculation = plan.should_include_calculation === true;
  const shouldIncludeList = plan.should_include_list === true;
  const shouldUseBold = plan.should_use_bold === true;
  const boldTargets = Array.isArray(plan.bold_targets)
    ? plan.bold_targets.map((item) => String(item)).filter(Boolean)
    : [];
  const suggestedSections = Array.isArray(plan.suggested_sections)
    ? plan.suggested_sections.map((item) => String(item)).filter(Boolean)
    : [];
  const writerNotes = typeof plan.writer_notes === "string" ? plan.writer_notes : "";

  return [
    "选题 Agent 写作计划审核规则：",
    "1. 这篇文章的目标篇幅、结构、是否用案例、是否算账、是否用列表，允许由选题 Agent 决定。",
    "2. 审核草稿有没有实质服从 writing_plan，但不要要求机械照抄章节。",
    `3. length_mode: ${lengthMode}`,
    targetMin || targetMax
      ? `4. 目标字数：至少 ${targetMin || "未知"} 个汉字；${targetMax || "未知"} 只是软参考，不是硬上限。`
      : null,
    structureMode ? `5. structure_mode: ${structureMode}` : null,
    `6. should_use_cases: ${shouldUseCases}`,
    `7. case_style: ${caseStyle}`,
    `8. should_include_calculation: ${shouldIncludeCalculation}`,
    `9. should_include_list: ${shouldIncludeList}`,
    `10. should_use_bold: ${shouldUseBold}`,
    boldTargets.length ? `11. bold_targets: ${boldTargets.join(" / ")}` : null,
    suggestedSections.length ? `12. suggested_sections: ${suggestedSections.join(" / ")}` : null,
    writerNotes ? `13. writer_notes: ${writerNotes}` : null,
    "14. target_words_min 是硬下限。草稿低于 target_words_min 时，除非 writing_plan 明显不安全或做不到，否则 editorial.decision 应为 REVISE。",
    "15. target_words_max 只是软参考。不要只因为超过它，就要求写作 Agent 把有用的回答缩短。",
    "16. 需要案例时，优先接受接近真实、数据自洽的典型/复合案例。不要要求编造真实朋友、真实盈利记录或无法核验的个人数据。",
    "17. should_use_cases=true 时，如果案例只说“访问不稳”“成本很高”这类抽象话，没有具体动作链，就算案例没写够。",
    "18. 可发布的开发/API 接入案例应尽量包含：项目背景、用了哪些模型、具体卡点（限流、超时、账单惊吓、迁移需求）、试过什么、最终怎么选、还剩什么局限。",
    "19. 如果题目/用户/来源上下文给了具体案例，草稿却无视它又没有安全理由，要求修改。",
    "20. 用户给的范文只是文风/质量参考，不是可复用原文。如果草稿抄了参考原文，或在不同题目里反复复用同一套故事，而当时还有别的案例可用，要求修改。",
    "21. 要求的案例/算账/列表缺失或明显没写够时，即使文章本身能读，也要求修改。",
    "22. should_use_bold=true 时，如果草稿没有对关键结论/风险/算账/原则做有意义的 **加粗**，要求修改。",
    "23. 反复使用“先说结论”“最后补一句”这类公式化开头结尾、让文章像模板时，要标出来。"
  ]
    .filter(Boolean)
    .join("\n");
}

function pickNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function buildHardGateFallback(): ReviewStageResult {
  return {
    decision: "PASS",
    issues: [],
    reason: ""
  };
}

function buildEditorialFallback(): ReviewStageResult {
  return {
    decision: "PASS",
    issues: [],
    score: 22,
    strengths: [],
    rewrite_brief: ""
  };
}

function buildPublishFallback(content: string): ReviewStageResult {
  return {
    decision: "PASS",
    issues: [],
    publish_ready: true,
    duplicate_reason: "",
    matched_past_contents: [],
    review_summary: "",
    approved_content: content
  };
}

function normalizeHardGate(value: Partial<ReviewStageResult> | null | undefined): ReviewStageResult {
  return {
    ...buildHardGateFallback(),
    ...(value ?? {}),
    decision: value?.decision === "BLOCK" ? "BLOCK" : "PASS",
    issues: normalizeStringArray(value?.issues),
    reason: typeof value?.reason === "string" ? value.reason : ""
  };
}

function containsForbiddenRelayDomain(value?: string | null) {
  return typeof value === "string" && /dududu\.cloud/i.test(value);
}

function applyForbiddenRelayDomainHardGate(
  hardGate: ReviewStageResult,
  ...texts: Array<string | null | undefined>
): ReviewStageResult {
  if (!texts.some((item) => containsForbiddenRelayDomain(item))) {
    return hardGate;
  }

  return {
    ...hardGate,
    decision: "BLOCK",
    issues: [
      ...hardGate.issues.filter((item) => !/dududu\.cloud/i.test(item)),
      "正文出现了禁止直写的 API 域名 dududu.cloud。需要给去处时只用文末参考文献 https://github.com/hehesama527/router-list 。"
    ],
    reason: "正文出现了禁止直写的 API 域名。"
  };
}

function normalizeEditorial(value: Partial<ReviewStageResult> | null | undefined): ReviewStageResult {
  return {
    ...buildEditorialFallback(),
    ...(value ?? {}),
    decision: value?.decision === "REVISE" ? "REVISE" : "PASS",
    issues: normalizeStringArray(value?.issues),
    score: normalizeScore(value?.score, 22),
    strengths: normalizeStringArray(value?.strengths),
    rewrite_brief: typeof value?.rewrite_brief === "string" ? value.rewrite_brief : "",
    quality: value?.quality ?? null
  };
}

function normalizePublish(value: Partial<ReviewStageResult> | null | undefined, content: string): ReviewStageResult {
  const normalizedDecision: ReviewStageResult["decision"] =
    value?.decision === "BLOCK_DUPLICATION" || value?.decision === "REVISE" ? value.decision : "PASS";

  const approvedContent =
    normalizedDecision === "PASS" && typeof value?.approved_content === "string" && value.approved_content.trim()
      ? value.approved_content
      : normalizedDecision === "PASS"
        ? content
        : "";

  return {
    ...buildPublishFallback(content),
    ...(value ?? {}),
    decision: normalizedDecision,
    issues: normalizeStringArray(value?.issues),
    publish_ready: typeof value?.publish_ready === "boolean" ? value.publish_ready : normalizedDecision === "PASS",
    duplicate_reason: typeof value?.duplicate_reason === "string" ? value.duplicate_reason : "",
    matched_past_contents: normalizeStringArray(value?.matched_past_contents),
    review_summary: typeof value?.review_summary === "string" ? value.review_summary : "",
    approved_content: approvedContent
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeScore(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeContentQuality(
  value: Partial<ContentQualityScore> | null | undefined,
  editorial: ReviewStageResult,
  publish: ReviewStageResult
): ContentQualityScore {
  const dimensions = normalizeQualityDimensions(value?.dimensions);
  const overallScore = normalizeScore(value?.overallScore, normalizeScore(editorial.score, 72));
  const passingScore = normalizeScore(value?.passingScore, 72);
  const issues = dedupeStringArray([
    ...normalizeStringArray(value?.issues),
    ...normalizeStringArray(editorial.issues),
    ...normalizeStringArray(publish.issues)
  ]);
  const manualReviewReasons = normalizeManualReviewReasons(value?.manualReviewReasons);

  if (overallScore < passingScore) {
    manualReviewReasons.push("low_quality_score");
  }
  if ((dimensions.ai_smell?.score ?? 100) < 55) {
    manualReviewReasons.push("high_ai_smell");
  }
  if ((dimensions.promotion_restraint?.score ?? 100) < 55) {
    manualReviewReasons.push("promotion_risk");
  }
  if ((dimensions.account_fit?.score ?? 100) < 55) {
    manualReviewReasons.push("account_mismatch");
  }
  if ((dimensions.evidence_density?.score ?? 100) < 50) {
    manualReviewReasons.push("weak_evidence");
  }

  return {
    overallScore,
    passingScore,
    dimensions,
    strengths: dedupeStringArray([...normalizeStringArray(value?.strengths), ...normalizeStringArray(editorial.strengths)]),
    issues,
    rewriteBrief:
      typeof value?.rewriteBrief === "string" && value.rewriteBrief.trim()
        ? value.rewriteBrief.trim()
        : editorial.rewrite_brief ?? publish.review_summary ?? "",
    manualReviewReasons: dedupeManualReviewReasons(manualReviewReasons)
  };
}

function normalizeQualityDimensions(value: unknown): Partial<Record<ContentQualityDimension, ContentQualityDimensionScore>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Partial<Record<ContentQualityDimension, Partial<ContentQualityDimensionScore>>>;
  const result: Partial<Record<ContentQualityDimension, ContentQualityDimensionScore>> = {};
  for (const key of QUALITY_DIMENSIONS) {
    const dimension = record[key];
    if (!dimension || typeof dimension !== "object") {
      continue;
    }
    result[key] = {
      score: normalizeScore(dimension.score, 72),
      issues: normalizeStringArray(dimension.issues),
      suggestion: typeof dimension.suggestion === "string" ? dimension.suggestion : ""
    };
  }
  return result;
}

function normalizeManualReviewReasons(value: unknown): ManualReviewReason[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ManualReviewReason => MANUAL_REVIEW_REASONS.includes(item as ManualReviewReason));
}

function dedupeStringArray(value: string[]) {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function dedupeManualReviewReasons(value: ManualReviewReason[]) {
  return [...new Set(value)];
}

const QUALITY_DIMENSIONS: ContentQualityDimension[] = [
  "account_fit",
  "zhihu_native",
  "experience_realness",
  "evidence_density",
  "structure_naturalness",
  "ai_smell",
  "promotion_restraint",
  "freshness"
];

const MANUAL_REVIEW_REASONS: ManualReviewReason[] = [
  "low_quality_score",
  "account_mismatch",
  "high_ai_smell",
  "promotion_risk",
  "weak_evidence",
  "rewrite_limit_reached"
];
