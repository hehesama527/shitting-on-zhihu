import type { PromptSnapshotMap, TopicPriority, TopicValidityStatus } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import { normalizeZhihuQuestionUrl } from "../utils/zhihu-url.js";
import {
  type AccountPromptContext,
  buildTopicPromptSuffix,
  buildTopicSoulPromptSuffix,
  buildTopicTargetProductPromptSuffix,
  joinPromptSuffixes
} from "./account-prompt-context.js";
import { BrowserSkillService } from "./browser-skill-service.js";
import { LlmService } from "./llm-service.js";
import { SessionService } from "./session-service.js";
import { TopicBatchPlannerService } from "./topic-batch-planner-service.js";
import { ZhihuAgentContextService } from "./zhihu-agent-context-service.js";

const TOPIC_BATCH_SIZE = 10;
const TOPIC_WIDE_POOL_SIZE = 30;
const DISCOVERY_LINK_LIMIT = 30;
const TOPIC_PREFILTER_BATCH_TIMEOUT_MS = 120_000;

type DiscoveryCandidate = {
  candidateId: number;
  questionUrl: string;
  questionTitle: string;
  sourceType: string;
  sourceMetadata: Record<string, unknown>;
};

type TopicAgentPrefilterOutput = {
  validity_status: TopicValidityStatus;
  validity_reason: string;
  title: string;
  summary: string;
  priority: TopicPriority;
  fit_score: number;
  question_type: string;
  persona_mode: string;
  target_audience: string[];
  pain_points: string[];
  recommended_angle: string;
  persona_hooks: string[];
  soft_promo_mode: string;
  soft_promo_reason: string;
  should_include_soft_promo: boolean;
  soft_promo_directive: {
    should_include: boolean;
    mode: string;
    reason: string;
    product_anchor: string;
    writer_instruction: string;
  };
  writing_plan: TopicWritingPlan;
  must_avoid: string[];
  risk_notes: string[];
  topic_fingerprint: {
    problem_core: string;
    answer_angle: string;
    target_pain: string;
    promo_entry: string;
  };
};

type TopicWritingPlan = {
  length_mode: "short" | "standard" | "long";
  target_words_min: number;
  target_words_max: number;
  structure_mode: string;
  should_use_cases: boolean;
  case_style: "none" | "typical_composite" | "personal_reflection" | "contrast_cases";
  should_include_calculation: boolean;
  should_include_list: boolean;
  should_use_bold: boolean;
  bold_targets: string[];
  suggested_sections: string[];
  writer_notes: string;
};

type TopicAgentPrefilterBatchOutput = {
  results: Array<
    {
      candidate_id: number;
    } & Partial<TopicAgentPrefilterOutput>
  >;
};

export class TopicDiscoveryService {
  private readonly agentContextService = new ZhihuAgentContextService();
  private readonly topicBatchPlannerService: TopicBatchPlannerService;

  constructor(
    private readonly topicRepository: TopicRepository,
    private readonly browserSkillService: BrowserSkillService,
    private readonly sessionService: SessionService,
    private readonly llmService: LlmService
  ) {
    this.topicBatchPlannerService = new TopicBatchPlannerService(llmService, topicRepository);
  }

  async harvestCandidates(input: {
    accountId: number;
    profileDir: string;
    promptSnapshot?: PromptSnapshotMap | null;
    accountContext?: AccountPromptContext | null;
    accountSoulMarkdown?: string | null;
    fillSharedBatch?: boolean;
  }) {
    const existingActiveCandidates = await this.topicRepository.countActiveCandidates(input.accountId);
    if (!input.fillSharedBatch && existingActiveCandidates > 0) {
      return 0;
    }
    if (input.fillSharedBatch && existingActiveCandidates >= TOPIC_BATCH_SIZE) {
      return 0;
    }

    await this.topicRepository.reconcileAcceptedCandidateStatuses();
    await this.topicRepository.markAnsweredHistoryCandidates(input.accountId);
    const activeCandidates = await this.topicRepository.countActiveCandidates(input.accountId);
    if (!input.fillSharedBatch && activeCandidates > 0) {
      return 0;
    }
    if (input.fillSharedBatch && activeCandidates >= TOPIC_BATCH_SIZE) {
      return 0;
    }

    const traceGroupId = `topic-discovery-${Date.now()}`;
    const sessionKey = `topic-discovery-${input.accountId}-${Date.now()}`;
    const traceContext = {
      sessionKey,
      profileDir: input.profileDir,
      stage: "topic_discovery" as const,
      traceGroupId,
      agentName: "topic_discovery" as const
    };

    try {
      await this.sessionService.ensureLoggedIn({
        sessionKey,
        profileDir: input.profileDir,
        traceGroupId,
        stage: "login_checking",
        url: `${getAppConfig().zhihuBaseUrl}/`,
        fallbackUrls: [`${getAppConfig().zhihuBaseUrl}/notifications`],
        promptSnapshot: input.promptSnapshot,
        expectedZhihuUserName: input.accountContext?.zhihuUserName ?? null,
        accountName: input.accountContext?.accountName ?? null
      });

      let remaining = TOPIC_WIDE_POOL_SIZE;
      const pastTopicFingerprints = await this.topicRepository.getRecentPublishedTopicFingerprints(10, input.accountId);
      const discoveredCandidateIds = new Set<number>();

      for (const keyword of getAppConfig().topicKeywords) {
        if (remaining <= 0) {
          break;
        }

        await this.browserSkillService.open(traceContext, {
          url: `${getAppConfig().zhihuBaseUrl}/search?type=content&q=${encodeURIComponent(keyword)}`
        });
        await this.browserSkillService.wait(traceContext, { ms: 1_500 });
        const snapshot = await this.browserSkillService.snapshot(traceContext);
        remaining -= await this.captureQuestionLinks(
          snapshot.questionLinks,
          "keyword_search",
          { keyword, titleOnlySelection: true },
          input.accountId,
          discoveredCandidateIds,
          remaining,
          input.promptSnapshot,
          pastTopicFingerprints,
          input.accountContext,
          input.accountSoulMarkdown
        );
      }

      if (remaining > 0) {
        await this.browserSkillService.open(traceContext, {
          url: `${getAppConfig().zhihuBaseUrl}/`
        });
        await this.browserSkillService.wait(traceContext, { ms: 1_500 });
        const recommendedSnapshot = await this.browserSkillService.snapshot(traceContext);
        remaining -= await this.captureQuestionLinks(
          recommendedSnapshot.questionLinks,
          "recommended_answer",
          { page: "home_recommend", titleOnlySelection: true },
          input.accountId,
          discoveredCandidateIds,
          remaining,
          input.promptSnapshot,
          pastTopicFingerprints,
          input.accountContext,
          input.accountSoulMarkdown
        );
      }

      if (remaining > 0) {
        await this.browserSkillService.open(traceContext, {
          url: `${getAppConfig().zhihuBaseUrl}/notifications`
        });
        await this.browserSkillService.wait(traceContext, { ms: 1_200 });
        const inviteSnapshot = await this.browserSkillService.snapshot(traceContext);
        remaining -= await this.captureQuestionLinks(
          inviteSnapshot.questionLinks,
          "invite_answer",
          { page: "notifications", titleOnlySelection: true },
          input.accountId,
          discoveredCandidateIds,
          remaining,
          input.promptSnapshot,
          pastTopicFingerprints,
          input.accountContext,
          input.accountSoulMarkdown
        );
      }

      await this.browserSkillService.closeSession(sessionKey);
      await this.keepTopTopicsAfterWideSelection({
        accountId: input.accountId,
        promptSnapshot: input.promptSnapshot,
        accountContext: input.accountContext,
        accountSoulMarkdown: input.accountSoulMarkdown
      });

      return this.topicRepository.countActiveCandidates(input.accountId);
    } finally {
      await this.browserSkillService.closeSession(sessionKey);
    }
  }

  private async captureQuestionLinks(
    links: Array<{ text: string; href: string }>,
    sourceType: string,
    sourceMetadata: Record<string, unknown>,
    accountId: number,
    discoveredCandidateIds: Set<number>,
    remaining: number,
    promptSnapshot: PromptSnapshotMap | null | undefined,
    pastTopicFingerprints: unknown[],
    accountContext?: AccountPromptContext | null,
    accountSoulMarkdown?: string | null
  ) {
    const pending: DiscoveryCandidate[] = [];

    for (const link of links.slice(0, DISCOVERY_LINK_LIMIT)) {
      const questionUrl = normalizeQuestionUrl(link.href);
      if (!questionUrl) {
        continue;
      }

      const candidate = await this.topicRepository.createOrGetCandidate({
        accountId,
        questionUrl,
        questionTitle: link.text,
        sourceType,
        sourceMetadata
      });

      if (discoveredCandidateIds.has(candidate.id)) {
        continue;
      }

      const validity = this.checkCandidateByTitle(link.text, questionUrl);
      await this.topicRepository.markCandidateValidity(candidate.id, validity.status, validity.reason);
      if (validity.status !== "valid") {
        continue;
      }

      const answeredTopic = await this.topicRepository.findAnsweredTopicByQuestionUrl(questionUrl, accountId);
      if (answeredTopic) {
        if (candidate.status !== "published") {
          await this.topicRepository.markCandidateDuplicate(candidate.id, answeredTopic.duplicateReason);
        }
        continue;
      }

      const claimedQuestion = await this.topicRepository.findClaimedQuestionByUrl(questionUrl, candidate.id);
      if (claimedQuestion) {
        if (candidate.status !== "published" && candidate.status !== "accepted") {
          await this.topicRepository.markCandidateDuplicate(candidate.id, claimedQuestion.duplicateReason);
        }
        continue;
      }

      pending.push({
        candidateId: candidate.id,
        questionUrl,
        questionTitle: link.text,
        sourceType,
        sourceMetadata
      });
    }

    if (pending.length === 0) {
      return 0;
    }

    const batchPrefilterResults = await this.runTopicPrefilterBatch(
      pending,
      promptSnapshot,
      pastTopicFingerprints,
      accountContext,
      accountSoulMarkdown
    );
    let added = 0;

    for (const candidate of pending) {
      const topicCard =
        batchPrefilterResults.get(candidate.candidateId) ??
        this.buildFallbackTopicCard(candidate, "topic_agent 批量预筛缺少结果，已走兜底。");

      await this.topicRepository.markCandidateValidity(
        candidate.candidateId,
        topicCard.validity_status,
        topicCard.validity_reason || null
      );

      await this.topicRepository.updateCandidateTopicMeta({
        candidateId: candidate.candidateId,
        priority: topicCard.priority,
        fitScore: topicCard.fit_score,
        questionType: topicCard.question_type,
        personaMode: topicCard.persona_mode,
        mustAvoid: topicCard.must_avoid,
        riskNotes: topicCard.risk_notes
      });
      await this.topicRepository.cacheCandidatePrefilter(candidate.candidateId, topicCard);

      if (topicCard.validity_status !== "valid") {
        await this.topicRepository.markCandidateBlocked(
          candidate.candidateId,
          topicCard.validity_reason || "topic_agent 预筛判定为无效，不进入当前批次。"
        );
        continue;
      }

      if (topicCard.priority === "SKIP") {
        await this.topicRepository.markCandidateBlocked(candidate.candidateId, "LLM 预筛判定为不相关，不进入当前批次。");
        continue;
      }

      if (added >= remaining) {
        await this.topicRepository.markCandidateBlocked(candidate.candidateId, "当前批次已满，本轮不纳入。");
        continue;
      }

      discoveredCandidateIds.add(candidate.candidateId);
      added += 1;
    }

    return added;
  }

  private async keepTopTopicsAfterWideSelection(input: {
    accountId: number;
    promptSnapshot: PromptSnapshotMap | null | undefined;
    accountContext?: AccountPromptContext | null;
    accountSoulMarkdown?: string | null;
  }) {
    const openCandidates = await this.topicRepository.listOpenCandidates(TOPIC_WIDE_POOL_SIZE, input.accountId);
    if (openCandidates.length <= TOPIC_BATCH_SIZE) {
      return;
    }

    const rankedCandidates = await this.topicBatchPlannerService.rankCandidatePool(
      openCandidates,
      input.promptSnapshot,
      input.accountContext,
      input.accountSoulMarkdown
    );
    const keepCandidateIds = new Set(rankedCandidates.slice(0, TOPIC_BATCH_SIZE).map((candidate) => candidate.id));

    for (const candidate of openCandidates) {
      if (keepCandidateIds.has(candidate.id)) {
        continue;
      }

      await this.topicRepository.markCandidateBlocked(
        candidate.id,
        "海选后二次筛选未进入前10：按流量潜力、产品适配度、情绪强度和账号契合度综合降级。"
      );
    }
  }

  private async runTopicPrefilterBatch(
    candidates: DiscoveryCandidate[],
    promptSnapshot: PromptSnapshotMap | null | undefined,
    pastTopicFingerprints: unknown[],
    accountContext?: AccountPromptContext | null,
    accountSoulMarkdown?: string | null
  ) {
    const agentContextDocuments = await this.agentContextService.ensureDocuments();
    const basePrompt = await this.llmService.resolvePrompt("topic_agent", {
      promptSnapshot,
      promptSuffix: joinPromptSuffixes(
        buildTopicPromptSuffix(accountContext),
        buildTopicSoulPromptSuffix(accountSoulMarkdown),
        buildTopicTargetProductPromptSuffix(agentContextDocuments)
      )
    });
    const batchPrompt = `${basePrompt}

案例规划：
1. GPT / Claude Code 接入、API 中转/代理选型、成本控制、工具选型、AI 辅助编程工作流题，默认 writing_plan.should_use_cases=true，除非只是极窄定义题。
2. 如果 sourceContext、后端 case_research、用户备注、标题或候选上下文里有具体项目故事、接入失败、迁移踩坑或用户给的例子，写进 recommended_angle 或 writing_plan.writer_notes，留给写作 Agent。
3. 可用案例必须包含项目背景（个人项目/小团队/创业）、用了哪些模型、具体卡点（限流、超时、账单惊吓、迁移需求、访问不稳）、试过什么、最终怎么选、还剩什么局限。
4. 用户给的范文只是文风/质量参考，不是可复用原文。不要在不同回答里反复用同一个项目故事、同一个模型名或同一套措辞。

补充说明：
1. 你现在执行的是 Topic Agent 的“批量标题预筛模式”，不是单题最终定稿模式。
2. 你只根据标题、URL、来源类型和 sourceContext 做预筛，不要假装看过详情页。
3. 这一轮需要你直接判断每个候选题对当前业务和当前账号来说是否有效。
4. validity_status 只能输出 "valid" 或 "invalid"。只有你明确认为该题应该进入后续选题流程时，才能输出 valid。
5. validity_reason 必须具体说明原因，不能只写“相关”或“不相关”。
6. priority 只对 validity_status = "valid" 的题目有实际意义；如果你认为该题无效，priority 统一输出 SKIP。
7. 如果信息不足，但标题并不明显无效，你也可以保守输出 valid，并给较低 fit_score 与 P2。
8. recommended_answer、invite_answer、keyword_search 都只是信号，不是硬规则。
9. 选题覆盖要从 product.md、target.md 和 Account Soul 一起判断，不要只盯固定关键词。
10. 当前流程是“先海选，再二次筛选”。预筛阶段不要过早收窄，只要标题属于 AI 开发、API 接入、工具选型、开发者心态等可写范围，且不是明显无关/违规/极冷工程题，可以先 valid 进入海选池。
11. 二次筛选会按流量潜力、产品/内容适配度、情绪强度、账号契合度保留前10。你的预筛输出也要体现这些判断。
12. 内容重心放在实际使用/想用 GPT、Claude Code 的开发者：官方接口访问不稳定、限流报错、账单/计费问题、接入方式选型、迁移评估、AI 辅助编程的实际使用体验。
13. 在方向符合时，尽量选流量更高的题：痛点更大众、讨论空间更大、搜索需求更稳定、标题更像真实用户会点的问题，应优先于很冷、很窄、很工程化的问题。
14. 情绪强的问题可以多保留，例如被限流卡住、突然收到高额账单、官方接口说崩就崩、迁移踩坑、担心中转服务不靠谱、一直卡在环境配置上要不要放弃。这类题即使不软广，也能作为高价值内容。
15. 工具对比/选型类题可以回复，也可以自然加入软广。重点是讲清官方直连 vs 中转/代理各自的适用场景和局限，不要写成产品测评合集。
16. AI 辅助编程类题可以回复，也可以自然加入软广。重点是怎么把 Claude Code / GPT 用得更顺手、更稳定、更省钱；严禁暗示某个中转服务能保证 100% 可用或能绕过官方限制。
17. 纯理论科普不再作为主要选题方向。题目如果主要是在讨论大模型原理、Prompt 工程理论、行业新闻，而不是开发者的真实访问/成本/稳定性痛点，validity_status 应倾向 invalid 或 priority=SKIP。
18. 泛开发者工具心态题可以保留，例如怎么选编程助手、怎么看代码生成质量这类题；但必须把它当作开发经验分享题处理，重点讲取舍、踩坑和实际体验，不要强行转成产品软广。
19. 泛开发者工具心态题默认 should_include_soft_promo=false、soft_promo_mode=none、topic_fingerprint.promo_entry=none，除非题目本身明确问 API 访问、成本控制或中转/代理服务。
20. 软广需要有节奏，不要每条都带。整体按约 10 条里 7 条自然带产品、3 条纯分享/纯经验/纯观点来控制。
21. 如果适合，把 should_include_soft_promo 设为 true，soft_promo_mode 设为 light 或 natural，并用 soft_promo_directive.writer_instruction 明确告诉 Writer 这篇需要自然加入 Dudu 中转站。
22. 如果不适合，把 should_include_soft_promo 设为 false，soft_promo_mode 设为 none，topic_fingerprint.promo_entry 写 none，并用 soft_promo_directive.writer_instruction 告诉 Writer 不强制加入软广，不要硬带 Dudu 中转站。
23. 只有当 Dudu 中转站的真实能力能解决标题里的具体一步时，才允许 should_include_soft_promo=true；不要因为业务目标需要推广就默认每篇都带。
24. 必须为每个有效选题输出 writing_plan，决定正文长度、是否需要案例、是否需要算账、是否适合列表/短标题、哪些重点需要加粗。
25. length_mode 选择规则：简单知识问答用 short；普通方法题用 standard；开发经历、弯路复盘、新手入门、成本优化、工具选型方法论、软文承接空间大的题用 long。
26. 字数规则：target_words_min 是 Writer 必须达到的硬下限；target_words_max 只是软参考，可以超过，不能为了压字数牺牲案例、算账和信息密度。
27. 案例规则：只有题目适合故事化时 should_use_cases=true；没有真实输入证据时 case_style 用 typical_composite 或 contrast_cases，可以要求 Writer 写接近真实的复合案例，但不要要求伪造真实项目经历。
28. 数据规则：案例里的调用量、并发数、月账单、限流次数等数字要贴近真实开发场景常识、保守且自洽，不要要求精确历史统计。
29. 加粗规则：standard/long 文章默认 should_use_bold=true，bold_targets 应指定 2-5 类重点，如核心结论、风险边界、成本结论、操作原则、产品边界。
30. suggested_sections 是结构提示，不是要求 Writer 原样使用的标题；避免反复输出“先说结论/最后补一句”这类固定模板。
31. 你必须为每个 candidate_id 输出且只输出一次结果。
32. 只输出 JSON，不要解释，不要 Markdown。

输出格式：
{
  "results": [
    {
      "candidate_id": 101,
      "validity_status": "valid | invalid",
      "validity_reason": "为什么有效或无效",
      "title": "建议使用的回答标题",
      "summary": "100-180字选题摘要",
      "priority": "P0 | P1 | P2 | SKIP",
      "fit_score": 0,
      "question_type": "工具推荐 | 方法验证 | 入门认知 | 选型对比 | 成本优化 | 稳定性排查 | 纯干货 | 其他",
      "persona_mode": "二牛实测型 | 二牛踩坑型 | 二牛对比型 | 二牛经验型",
      "target_audience": ["目标读者1"],
      "pain_points": ["痛点1"],
      "recommended_angle": "最适合切入的写法",
      "persona_hooks": ["适合强化人设的细节"],
      "soft_promo_mode": "none | light | natural",
      "soft_promo_reason": "为什么适合或不适合自然植入",
      "should_include_soft_promo": false,
      "soft_promo_directive": {
        "should_include": false,
        "mode": "none | light | natural",
        "reason": "选题层面的软广适配判断",
        "product_anchor": "适合植入时写具体承接点，不适合写空字符串",
        "writer_instruction": "给 Writer 的明确执行指令"
      },
      "writing_plan": {
        "length_mode": "short | standard | long",
        "target_words_min": 900,
        "target_words_max": 1300,
        "structure_mode": "例如：开头判断 + 典型案例 + 算账 + 具体做法 + 克制收口",
        "should_use_cases": false,
        "case_style": "none | typical_composite | personal_reflection | contrast_cases",
        "should_include_calculation": false,
        "should_include_list": false,
        "should_use_bold": true,
        "bold_targets": ["核心结论", "风险边界", "算账结论"],
        "suggested_sections": ["开头判断", "典型情况", "算账段", "具体做法", "克制收口"],
        "writer_notes": "给 Writer 的长度、案例和结构执行提醒"
      },
      "must_avoid": ["绝对不能写的点"],
      "risk_notes": ["平台风险或理解风险"],
      "topic_fingerprint": {
        "problem_core": "问题本质",
        "answer_angle": "回答角度",
        "target_pain": "目标用户痛点",
        "promo_entry": "软广切入口，没有就写 none"
      }
    }
  ]
}`;

    const fallback: TopicAgentPrefilterBatchOutput = {
      results: candidates.map((candidate) => ({
        candidate_id: candidate.candidateId,
        ...this.buildFallbackTopicCard(candidate, "topic_agent 批量预筛超时或异常，已走兜底。")
      }))
    };

    let response: TopicAgentPrefilterBatchOutput;
    try {
      response = await this.llmService.runJsonWithSystemPrompt<TopicAgentPrefilterBatchOutput>(
        batchPrompt,
        {
          candidates: candidates.map((candidate) => ({
            candidate_id: candidate.candidateId,
            questionUrl: candidate.questionUrl,
            questionTitle: candidate.questionTitle,
            sourceType: candidate.sourceType,
            sourceContext: {
              primarySource: candidate.sourceType,
              latestSourceType: candidate.sourceType,
              discoveredSources: [candidate.sourceType],
              sourceEvents: [
                {
                  sourceType: candidate.sourceType,
                  metadata: candidate.sourceMetadata
                }
              ],
              titleOnlySelection: true
            }
          })),
          pastTopicFingerprints
        },
        fallback,
        TOPIC_PREFILTER_BATCH_TIMEOUT_MS
      );
    } catch {
      response = fallback;
    }

    const results = Array.isArray(response.results) ? response.results : [];
    const byCandidateId = new Map<number, TopicAgentPrefilterOutput>();

    for (const candidate of candidates) {
      const matched = results.find((item) => Number(item?.candidate_id) === candidate.candidateId);
      byCandidateId.set(
        candidate.candidateId,
        this.normalizePrefilterOutput(
          candidate,
          matched,
          matched ? null : "topic_agent 批量预筛未返回该候选题，已走兜底。"
        )
      );
    }

    return byCandidateId;
  }

  private normalizePrefilterOutput(
    candidate: DiscoveryCandidate,
    output: ({ candidate_id?: number } & Partial<TopicAgentPrefilterOutput>) | undefined,
    fallbackReason?: string | null
  ): TopicAgentPrefilterOutput {
    const fallback = this.buildFallbackTopicCard(candidate, fallbackReason);
    if (!output) {
      return fallback;
    }

    const normalizedValidityStatus = normalizeValidityStatus(output.validity_status, fallback.validity_status);
    const normalizedValidityReason = normalizeString(output.validity_reason, fallback.validity_reason);
    const normalizedPriority =
      normalizedValidityStatus === "invalid"
        ? "SKIP"
        : normalizePriority(output.priority, fallback.priority);
    const normalizedFitScore =
      normalizedValidityStatus === "invalid"
        ? 0
        : normalizeFitScore(output.fit_score, fallback.fit_score);

    const rawMode = normalizeSoftPromoMode(output.soft_promo_mode, fallback.soft_promo_mode);
    const shouldInclude =
      normalizedValidityStatus === "valid" &&
      (typeof output.should_include_soft_promo === "boolean"
        ? output.should_include_soft_promo
        : rawMode === "light" || rawMode === "natural");
    const softPromoMode = shouldInclude ? (rawMode === "none" ? "light" : rawMode) : "none";
    const rawPromoEntry = normalizeString(output.topic_fingerprint?.promo_entry, "none");
    const softPromoReason = normalizeString(
      output.soft_promo_reason,
      shouldInclude ? "该选题与产品真实能力存在自然承接点。" : fallback.soft_promo_reason
    );
    const softPromoDirective = normalizeSoftPromoDirective(output.soft_promo_directive, {
      shouldInclude,
      mode: softPromoMode,
      reason: softPromoReason,
      productAnchor: shouldInclude && rawPromoEntry !== "none" ? rawPromoEntry : ""
    });

    const normalized: TopicAgentPrefilterOutput = {
      validity_status: normalizedValidityStatus,
      validity_reason: normalizedValidityReason,
      title: normalizeString(output.title, candidate.questionTitle),
      summary: normalizeString(output.summary, candidate.questionTitle),
      priority: normalizedPriority,
      fit_score: normalizedFitScore,
      question_type: normalizeString(output.question_type, fallback.question_type),
      persona_mode: normalizeString(output.persona_mode, fallback.persona_mode),
      target_audience: normalizeStringArray(output.target_audience),
      pain_points: normalizeStringArray(output.pain_points),
      recommended_angle: normalizeString(output.recommended_angle, fallback.recommended_angle),
      persona_hooks: normalizeStringArray(output.persona_hooks),
      soft_promo_mode: softPromoMode,
      soft_promo_reason: softPromoReason,
      should_include_soft_promo: shouldInclude,
      soft_promo_directive: softPromoDirective,
      writing_plan: normalizeWritingPlan(output.writing_plan, fallback.writing_plan),
      must_avoid: normalizeStringArray(output.must_avoid),
      risk_notes: mergeUniqueStrings([
        ...normalizeStringArray(output.risk_notes),
        ...((fallbackReason ? [fallbackReason] : []).filter(Boolean) as string[])
      ]),
      topic_fingerprint: {
        problem_core: normalizeString(output.topic_fingerprint?.problem_core, candidate.questionTitle),
        answer_angle: normalizeString(output.topic_fingerprint?.answer_angle, ""),
        target_pain: normalizeString(output.topic_fingerprint?.target_pain, ""),
        promo_entry: shouldInclude ? rawPromoEntry || softPromoDirective.product_anchor || "待 Writer 自然确认" : "none"
      }
    };

    normalized.writing_plan = applyCaseDrivenWritingPlanDefaults(
      normalized.writing_plan,
      [
        candidate.questionTitle,
        normalized.title,
        normalized.summary,
        normalized.question_type,
        normalized.recommended_angle,
        normalized.pain_points.join("\n"),
        normalized.persona_hooks.join("\n")
      ].join("\n")
    );

    return normalized;
  }

  private buildFallbackTopicCard(candidate: DiscoveryCandidate, fallbackReason?: string | null): TopicAgentPrefilterOutput {
    const normalizedTitle = normalizeSnapshotText(candidate.questionTitle);

    return {
      validity_status: "invalid",
      validity_reason: fallbackReason ?? "topic_agent 预筛未正常返回，当前候选题已按保守策略拦截。",
      title: candidate.questionTitle,
      summary: candidate.questionTitle,
      priority: "SKIP",
      fit_score: 0,
      question_type: "其他",
      persona_mode: "二牛经验型",
      target_audience: [],
      pain_points: [],
      recommended_angle: "",
      persona_hooks: [],
      soft_promo_mode: "none",
      soft_promo_reason: "预筛兜底结果未确认软广契合点。",
      should_include_soft_promo: false,
      soft_promo_directive: buildSoftPromoDirective({
        shouldInclude: false,
        mode: "none",
        reason: "预筛兜底结果未确认软广契合点。",
        productAnchor: ""
      }),
      writing_plan: buildFallbackWritingPlan(),
      must_avoid: [],
      risk_notes: fallbackReason ? [fallbackReason] : [],
      topic_fingerprint: {
        problem_core: normalizedTitle || candidate.questionTitle,
        answer_angle: "",
        target_pain: "",
        promo_entry: "none"
      }
    };
  }

  private checkCandidateByTitle(questionTitle: string, questionUrl: string) {
    const normalizedTitle = normalizeSnapshotText(questionTitle);
    const normalizedUrl = normalizeSnapshotText(questionUrl);

    if (!normalizedUrl) {
      return {
        status: "invalid" as const,
        reason: "候选题缺少有效问题链接。"
      };
    }

    const meaningfulTitle = normalizedTitle.replaceAll("?", "").replaceAll("？", "");
    if (!meaningfulTitle) {
      return {
        status: "invalid" as const,
        reason: "候选题标题为空或无有效文本。"
      };
    }

    return {
      status: "valid" as const,
      reason: "基础字段校验通过，进入 topic_agent 预筛判断。"
    };
  }
}

function normalizeQuestionUrl(href: string) {
  return normalizeZhihuQuestionUrl(href);
}

function normalizeSnapshotText(value: string) {
  return value.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, "").trim();
}

function normalizeString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

// 2026-09 产品定位从 CryptoPathX 切换为 dudu 中转站后，这里的正则也从
// "币圈/交易术语" 换成 "大模型 API 接入/中转相关术语"，用来判断某个选题是否
// 需要走"案例驱动"的写作默认值（更长篇幅、要求带具体案例）。
const CASE_DRIVEN_TOPIC_PATTERNS = [
  /gpt/iu,
  /claude/iu,
  /codex/iu,
  /openrouter/iu,
  /\u5927\u6a21\u578b|\u4e2d\u8f6c|\u4ee3\u7406|\u9650\u6d41|\u63a5\u5165|\u90e8\u7f72|\u8c03\u7528|\u8ba1\u8d39|\u8d26\u5355|\u5c01\u53f7|\u98ce\u63a7/u,
  /\bAPI\b|\bSDK\b|\bToken\b/iu
];

function shouldUseCaseDrivenDefaults(seedText: string) {
  return CASE_DRIVEN_TOPIC_PATTERNS.some((pattern) => pattern.test(seedText));
}

function appendCaseWriterNote(existing: string) {
  const note =
    "案例驱动默认：开发者/API 接入/工具选题里，至少用一个具体案例承担核心论证。优先用来源材料、用户提供案例或后端 case_research；没有的话就写接近真实的复合案例，包含项目背景、具体卡点（限流、超时、账单惊吓、迁移需求、访问不稳）、试过什么、最终怎么选、还剩什么局限。不要在不同回答里反复用同一个项目故事、模型名或参考原文。";

  if (!existing) {
    return note;
  }
  if (existing.includes("案例驱动默认")) {
    return existing;
  }
  return `${existing}\n${note}`;
}

function appendUniqueItems(existing: string[], items: string[]) {
  const next = [...existing];
  for (const item of items) {
    if (!next.includes(item)) {
      next.push(item);
    }
  }
  return next;
}

function applyCaseDrivenWritingPlanDefaults(plan: TopicWritingPlan, seedText: string): TopicWritingPlan {
  if (!shouldUseCaseDrivenDefaults(seedText)) {
    return plan;
  }

  const targetMin = Math.max(plan.target_words_min, 2200);
  const targetMax = Math.max(plan.target_words_max, 3500, targetMin);

  return {
    ...plan,
    length_mode: plan.length_mode === "short" ? "standard" : "long",
    target_words_min: Math.min(targetMin, 2600),
    target_words_max: Math.min(Math.max(targetMax, 3500), 5000),
    structure_mode: plan.structure_mode
      ? `${plan.structure_mode} + case action chain`
      : "direct judgment + concrete case action chain + calculation/review + practical boundary",
    should_use_cases: true,
    case_style: plan.case_style === "none" ? "typical_composite" : plan.case_style,
    should_include_calculation: true,
    should_use_bold: true,
    bold_targets: appendUniqueItems(plan.bold_targets, [
      "core judgment",
      "risk boundary",
      "case takeaway",
      "operating principle"
    ]).slice(0, 6),
    suggested_sections: appendUniqueItems(plan.suggested_sections, [
      "concrete case",
      "action chain",
      "review takeaway"
    ]).slice(0, 10),
    writer_notes: appendCaseWriterNote(plan.writer_notes)
  };
}

function buildFallbackWritingPlan(): TopicWritingPlan {
  return {
    length_mode: "standard",
    target_words_min: 2200,
    target_words_max: 3500,
    structure_mode: "开头判断 + 具体理由 + 方法建议 + 克制收口",
    should_use_cases: false,
    case_style: "none",
    should_include_calculation: false,
    should_include_list: false,
    should_use_bold: true,
    bold_targets: ["核心结论", "风险边界", "算账结论", "操作原则"],
    suggested_sections: ["开头判断", "核心原因", "具体做法", "克制收口"],
    writer_notes: "按题目自然展开，target_words_min 是硬下限；不要为了长度重复观点。"
  };
}

function normalizeWritingPlan(value: unknown, fallback: TopicWritingPlan): TopicWritingPlan {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const lengthMode =
    record.length_mode === "short" || record.length_mode === "standard" || record.length_mode === "long"
      ? record.length_mode
      : fallback.length_mode;
  const defaultRange =
    lengthMode === "long"
      ? { min: 2200, max: 3500 }
      : lengthMode === "short"
        ? { min: 800, max: 1200 }
        : { min: 1800, max: 3000 };
  const min = normalizeWordCount(record.target_words_min, fallback.target_words_min || defaultRange.min, 2600);
  const max = normalizeWordCount(record.target_words_max, fallback.target_words_max || defaultRange.max, 5000);
  const caseStyle =
    record.case_style === "typical_composite" ||
    record.case_style === "personal_reflection" ||
    record.case_style === "contrast_cases" ||
    record.case_style === "none"
      ? record.case_style
      : fallback.case_style;
  const suggestedSections = normalizeStringArray(record.suggested_sections);

  return {
    length_mode: lengthMode,
    target_words_min: Math.min(min, max),
    target_words_max: Math.max(min, max),
    structure_mode: normalizeString(record.structure_mode, fallback.structure_mode),
    should_use_cases:
      typeof record.should_use_cases === "boolean"
        ? record.should_use_cases
        : fallback.should_use_cases,
    case_style: caseStyle,
    should_include_calculation:
      typeof record.should_include_calculation === "boolean"
        ? record.should_include_calculation
        : fallback.should_include_calculation,
    should_include_list:
      typeof record.should_include_list === "boolean"
        ? record.should_include_list
        : fallback.should_include_list,
    should_use_bold:
      typeof record.should_use_bold === "boolean"
        ? record.should_use_bold
        : fallback.should_use_bold,
    bold_targets: normalizeStringArray(record.bold_targets).length
      ? normalizeStringArray(record.bold_targets).slice(0, 6)
      : fallback.bold_targets,
    suggested_sections: suggestedSections.length ? suggestedSections.slice(0, 10) : fallback.suggested_sections,
    writer_notes: normalizeString(record.writer_notes, fallback.writer_notes)
  };
}

function normalizeWordCount(value: unknown, fallback: number, maxValue = 5000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(400, Math.min(maxValue, Math.round(numeric)));
}

function normalizePriority(value: unknown, fallback: TopicPriority): TopicPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "SKIP" ? value : fallback;
}

function normalizeFitScore(value: unknown, fallback: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const normalized = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function normalizeSoftPromoMode(value: unknown, fallback: string) {
  return value === "none" || value === "light" || value === "natural" ? value : fallback;
}

function normalizeSoftPromoDirective(
  value: unknown,
  fallback: {
    shouldInclude: boolean;
    mode: string;
    reason: string;
    productAnchor: string;
  }
) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const shouldInclude =
    typeof record.should_include === "boolean" ? record.should_include : fallback.shouldInclude;
  const mode = shouldInclude ? normalizeSoftPromoMode(record.mode, fallback.mode) : "none";
  const reason = normalizeString(record.reason, fallback.reason);
  const productAnchor = normalizeString(record.product_anchor, fallback.productAnchor);
  const writerInstruction = normalizeString(
    record.writer_instruction,
    buildSoftPromoWriterInstruction({ shouldInclude, mode, reason, productAnchor })
  );

  return {
    should_include: shouldInclude,
    mode,
    reason,
    product_anchor: shouldInclude ? productAnchor : "",
    writer_instruction: writerInstruction
  };
}

function buildSoftPromoDirective(input: {
  shouldInclude: boolean;
  mode: string;
  reason: string;
  productAnchor: string;
}) {
  return {
    should_include: input.shouldInclude,
    mode: input.shouldInclude ? input.mode : "none",
    reason: input.reason,
    product_anchor: input.shouldInclude ? input.productAnchor : "",
    writer_instruction: buildSoftPromoWriterInstruction(input)
  };
}

function buildSoftPromoWriterInstruction(input: {
  shouldInclude: boolean;
  mode: string;
  reason: string;
  productAnchor: string;
}) {
  if (!input.shouldInclude) {
    return "Topic Agent 判断该选题不适合强制加入软广。Writer 应优先把问题回答完整，不要为了推广硬带 Dudu 中转站。";
  }

  const anchor = input.productAnchor ? `承接点：${input.productAnchor}。` : "";
  return `Topic Agent 判断该选题适合自然加入软广，Writer 需要在不破坏回答价值的前提下自然提到 Dudu 中转站。${anchor}原因：${input.reason}`;
}

function normalizeValidityStatus(value: unknown, fallback: TopicValidityStatus): TopicValidityStatus {
  return value === "valid" || value === "invalid" || value === "unchecked" ? value : fallback;
}

function mergeUniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
