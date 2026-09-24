import type { JobStage, PromptSnapshotMap, TopicPriority } from "@zhihu-mvp/shared";
import { TopicRepository } from "../repositories/topic-repository.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { safeParseJson } from "../utils/json.js";
import {
  type AccountPromptContext,
  buildTopicPromptSuffix,
  buildTopicSoulPromptSuffix,
  buildTopicTargetProductPromptSuffix,
  buildWriterPromptSuffix,
  buildWriterSoulPromptSuffix,
  buildWriterTargetProductPromptSuffix,
  joinPromptSuffixes
} from "./account-prompt-context.js";
import { HumanizerService } from "./humanizer-service.js";
import { LlmService } from "./llm-service.js";
import { ReviewService } from "./review-service.js";
import { TopicBatchPlannerService } from "./topic-batch-planner-service.js";
import { TopicReviewService } from "./topic-review-service.js";
import { type ZhihuAgentContextDocuments, ZhihuAgentContextService } from "./zhihu-agent-context-service.js";
import { type ZhihuCaseResearchOutput, ZhihuCaseResearchService } from "./zhihu-case-research-service.js";

type PreparedDraftResult =
  | {
      kind: "ready";
      title: string;
      topicCardId: number;
      reviewId: number;
      approvedContent: string;
      promptVersionSnapshotJson: string;
    }
  | {
      kind: "duplicate";
      reason: string;
    }
  | {
      kind: "blocked";
      reason: string;
      needsManualReview?: boolean;
    };

type TopicAgentOutput = {
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
  case_research?: ZhihuCaseResearchOutput;
};

export type TopicWritingPlan = {
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

export type WriterAccountContext = AccountPromptContext;

const MAX_REWRITE_ATTEMPTS = 5;
const MAX_DRAFT_REVIEW_ATTEMPTS = MAX_REWRITE_ATTEMPTS + 1;

export class TopicPipelineService {
  private readonly agentContextService = new ZhihuAgentContextService();
  private readonly caseResearchService: ZhihuCaseResearchService;

  constructor(
    private readonly llmService: LlmService,
    private readonly topicRepository: TopicRepository,
    private readonly topicBatchPlannerService: TopicBatchPlannerService,
    private readonly topicReviewService: TopicReviewService,
    private readonly reviewService: ReviewService,
    private readonly humanizerService: HumanizerService
  ) {
    this.caseResearchService = new ZhihuCaseResearchService(this.llmService);
  }

  async prepareNextPublishableDraft(input?: {
    publishJobId?: number | null;
    promptSnapshot?: PromptSnapshotMap | null;
    accountContext?: WriterAccountContext | null;
    accountSoulMarkdown?: string | null;
    onStage?: (stage: JobStage) => Promise<void> | void;
  }) {
    const startedAt = Date.now();
    logDebugTiming("topicPipeline.prepareNextPublishableDraft", "start", {
      publishJobId: input?.publishJobId ?? null,
      accountId: input?.accountContext?.accountId ?? null
    });

    const promptSnapshot = input?.promptSnapshot ?? (await this.llmService.getActivePromptSnapshot());
    const agentContextDocuments = await this.agentContextService.ensureDocuments();

    // Keep the injected service referenced for backward-compatible wiring.
    void this.topicReviewService;

    await this.topicRepository.markAnsweredHistoryCandidates(input?.accountContext?.accountId ?? null);
    const candidatePool = await this.topicRepository.listOpenCandidates(10, input?.accountContext?.accountId ?? null);
    const rankedCandidatePool = await this.topicBatchPlannerService.rankCandidatePool(
      candidatePool,
      promptSnapshot,
      input?.accountContext ?? null,
      input?.accountSoulMarkdown ?? null
    );
    logDebugTiming("topicPipeline.prepareNextPublishableDraft", "loaded_candidates", {
      publishJobId: input?.publishJobId ?? null,
      accountId: input?.accountContext?.accountId ?? null,
      candidatePoolSize: candidatePool.length,
      rankedCandidatePoolSize: rankedCandidatePool.length,
      elapsedMs: getElapsedMs(startedAt)
    });
    const pastTopicFingerprints = await this.topicRepository.getRecentPublishedTopicFingerprints(
      10,
      input?.accountContext?.accountId ?? null
    );
    const pastContentFingerprints = await this.topicRepository.getRecentPublishedContentFingerprints(10);

    for (const candidate of rankedCandidatePool) {
      const candidateStartedAt = Date.now();
      logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_start", {
        publishJobId: input?.publishJobId ?? null,
        candidateId: candidate.id,
        questionTitle: candidate.questionTitle
      });

      const answeredTopic = await this.topicRepository.findAnsweredTopicByQuestionUrl(candidate.questionUrl);
      if (answeredTopic) {
        await this.topicRepository.markCandidateDuplicate(candidate.id, answeredTopic.duplicateReason);
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_answered_duplicate", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }

      const claimedQuestion = await this.topicRepository.findClaimedQuestionByUrl(candidate.questionUrl, candidate.id);
      if (claimedQuestion && claimedQuestion.status !== "new") {
        await this.topicRepository.markCandidateDuplicate(candidate.id, claimedQuestion.duplicateReason);
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_claimed_duplicate", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          ownerCandidateId: claimedQuestion.id,
          ownerAccountId: claimedQuestion.accountId,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }

      const sourceContext = safeParseJson<Record<string, unknown>>(candidate.sourceMetadataText ?? "{}", {});
      let topicCard = normalizeCachedTopicAgentOutput(sourceContext.prefilterTopicCard, candidate.questionTitle);

      if (!topicCard) {
        await input?.onStage?.("topic_agent");
        topicCard = await this.llmService.runJson<TopicAgentOutput>(
          "topic_agent",
          {
            candidate: {
              ...candidate,
              sourceContext: {
                primarySource: candidate.sourceType,
                latestSourceType:
                  typeof sourceContext.latestSourceType === "string" ? sourceContext.latestSourceType : candidate.sourceType,
                discoveredSources: Array.isArray(sourceContext.discoveredSources)
                  ? sourceContext.discoveredSources.map((item) => String(item)).filter(Boolean)
                  : [candidate.sourceType],
                sourceEvents: Array.isArray(sourceContext.sourceEvents) ? sourceContext.sourceEvents : []
              }
            },
            pastTopicFingerprints
          },
          buildTopicAgentFallback(candidate.questionTitle),
          {
            promptSnapshot,
            promptSuffix: joinPromptSuffixes(
              buildTopicPromptSuffix(input?.accountContext),
              buildTopicSoulPromptSuffix(input?.accountSoulMarkdown),
              buildTopicTargetProductPromptSuffix(agentContextDocuments),
              buildTopicAgentSingleSelectionPromptSuffix()
            )
          }
        );
        topicCard = normalizeTopicAgentOutput(topicCard, candidate.questionTitle);
        await this.topicRepository.cacheCandidatePrefilter(candidate.id, topicCard);
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_topic_agent_done", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
      }

      await this.topicRepository.updateCandidateTopicMeta({
        candidateId: candidate.id,
        priority: topicCard.priority,
        fitScore: topicCard.fit_score,
        questionType: topicCard.question_type,
        personaMode: topicCard.persona_mode,
        mustAvoid: topicCard.must_avoid ?? [],
        riskNotes: topicCard.risk_notes ?? []
      });

      if (topicCard.priority === "SKIP") {
        await this.topicRepository.markCandidateBlocked(candidate.id, "topic skipped by scripted prefilter");
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_skipped", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }

      topicCard = await this.attachCaseResearchToTopicCard({
        questionTitle: candidate.questionTitle,
        questionUrl: candidate.questionUrl,
        topicCard,
        sourceContext
      });

      const claim = await this.topicRepository.claimQuestionUrlForWriting(candidate.id, candidate.questionUrl);
      if (!claim.claimed) {
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_claim_failed", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          reason: claim.reason,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }
      if (topicCard.topic_fingerprint) {
        await this.topicRepository.markCandidateProcessing(candidate.id, JSON.stringify(topicCard.topic_fingerprint));
      }

      // Historical duplicate screening now uses only the normalized question URL.
      const topicCardId = await this.topicRepository.createTopicCard(
        candidate.id,
        topicCard.summary ?? candidate.questionTitle,
        JSON.stringify(topicCard)
      );

      const preparedDraft = await this.generateReviewedDraft(
        {
          publishJobId: input?.publishJobId ?? null,
          topicCardId,
          candidateTitle: candidate.questionTitle,
          questionUrl: candidate.questionUrl,
          topicCard,
          pastContentFingerprints,
          accountContext: input?.accountContext ?? null,
          accountSoulMarkdown: input?.accountSoulMarkdown ?? null,
          agentContextDocuments,
          onStage: input?.onStage
        },
        promptSnapshot
      );

      if (!preparedDraft || preparedDraft.kind === "blocked") {
        if (preparedDraft?.kind === "blocked" && preparedDraft.needsManualReview && input?.publishJobId) {
          logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_needs_manual_review", {
            publishJobId: input.publishJobId,
            candidateId: candidate.id,
            reason: preparedDraft.reason,
            elapsedMs: getElapsedMs(candidateStartedAt)
          });
          return preparedDraft;
        }

        await this.topicRepository.markCandidateBlocked(
          candidate.id,
          preparedDraft?.kind === "blocked" ? preparedDraft.reason : "draft blocked before publish"
        );
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_blocked", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          reason: preparedDraft?.kind === "blocked" ? preparedDraft.reason : "draft blocked before publish",
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }

      if (preparedDraft.kind === "duplicate") {
        await this.topicRepository.markCandidateDuplicate(candidate.id, preparedDraft.reason);
        logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_duplicate", {
          publishJobId: input?.publishJobId ?? null,
          candidateId: candidate.id,
          reason: preparedDraft.reason,
          elapsedMs: getElapsedMs(candidateStartedAt)
        });
        continue;
      }

      await this.topicRepository.markCandidateAccepted(candidate.id, JSON.stringify(topicCard.topic_fingerprint ?? {}));
      logDebugTiming("topicPipeline.prepareNextPublishableDraft", "candidate_ready", {
        publishJobId: input?.publishJobId ?? null,
        candidateId: candidate.id,
        topicCardId: preparedDraft.topicCardId,
        reviewId: preparedDraft.reviewId,
        elapsedMs: getElapsedMs(candidateStartedAt),
        totalElapsedMs: getElapsedMs(startedAt)
      });
      return {
        ...preparedDraft,
        questionUrl: candidate.questionUrl
      };
    }

    logDebugTiming("topicPipeline.prepareNextPublishableDraft", "no_candidate_ready", {
      publishJobId: input?.publishJobId ?? null,
      accountId: input?.accountContext?.accountId ?? null,
      elapsedMs: getElapsedMs(startedAt)
    });
    return null;
  }

  async rewriteExistingTopic(input: {
    publishJobId?: number | null;
    topicCardId: number;
    candidateTitle: string;
    questionUrl: string;
    revisionFeedback: string;
    promptVersionSnapshotJson: string | null;
    accountContext?: WriterAccountContext | null;
    accountSoulMarkdown?: string | null;
    maxAttempts?: number;
    onStage?: (stage: JobStage) => Promise<void> | void;
  }) {
    const topicCardRecord = await this.topicRepository.getTopicCardById(input.topicCardId);
    if (!topicCardRecord) {
      return null;
    }

    const promptSnapshot = safeParseJson<PromptSnapshotMap>(input.promptVersionSnapshotJson ?? "{}", {});
    const pastContentFingerprints = await this.topicRepository.getRecentPublishedContentFingerprints(10);
    const topicCard = normalizeTopicAgentOutput(safeParseJson<Record<string, unknown>>(topicCardRecord.output_json, {
      summary: topicCardRecord.summary_text
    }), input.candidateTitle);

    return this.generateReviewedDraft(
      {
        publishJobId: input.publishJobId ?? null,
        topicCardId: input.topicCardId,
        candidateTitle: input.candidateTitle,
        questionUrl: input.questionUrl,
        topicCard,
        pastContentFingerprints,
        revisionFeedback: input.revisionFeedback,
        accountContext: input.accountContext ?? null,
        accountSoulMarkdown: input.accountSoulMarkdown ?? null,
        maxAttempts: input.maxAttempts,
        onStage: input.onStage
      },
      promptSnapshot
    );
  }

  private async generateReviewedDraft(
    input: {
      publishJobId: number | null;
      topicCardId: number;
      candidateTitle: string;
      questionUrl: string;
      topicCard: Record<string, unknown>;
      pastContentFingerprints: unknown[];
      revisionFeedback?: string;
      accountContext?: WriterAccountContext | null;
      accountSoulMarkdown?: string | null;
      agentContextDocuments?: ZhihuAgentContextDocuments | null;
      maxAttempts?: number;
      onStage?: (stage: JobStage) => Promise<void> | void;
    },
    promptSnapshot: PromptSnapshotMap
  ): Promise<PreparedDraftResult | null> {
    const startedAt = Date.now();
    let revisionFeedback = input.revisionFeedback ?? "";
    const agentContextDocuments = input.agentContextDocuments ?? (await this.agentContextService.ensureDocuments());
    const topicCard = await this.attachCaseResearchToTopicCard({
      questionTitle: input.candidateTitle,
      questionUrl: input.questionUrl,
      topicCard: input.topicCard
    });
    const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? MAX_DRAFT_REVIEW_ATTEMPTS, MAX_DRAFT_REVIEW_ATTEMPTS));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const attemptStartedAt = Date.now();
      logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_start", {
        publishJobId: input.publishJobId,
        topicCardId: input.topicCardId,
        attempt: attempt + 1
      });

      await input.onStage?.("writer");
      const writerOutput = await this.llmService.runJson(
        "writer_agent",
        {
          questionTitle: input.candidateTitle,
          questionUrl: input.questionUrl,
          topicCard,
          softPromoDirective: resolveSoftPromoDirective(topicCard),
          revisionFeedback
        },
        {
          title: input.candidateTitle,
          summary: "",
          content: "",
          fingerprint: {
            opening_angle: "",
            core_claims: [],
            case_structure: "",
            closing_style: ""
          }
        },
        {
          promptSnapshot,
          promptSuffix: joinPromptSuffixes(
            buildWriterPromptSuffix(input.accountContext),
            buildWriterTargetProductPromptSuffix(agentContextDocuments),
            buildWriterSoulPromptSuffix(input.accountSoulMarkdown),
            buildWriterCaseResearchPromptSuffix(topicCard),
            buildWriterWritingPlanPromptSuffix(topicCard),
            buildWriterSoftPromoPromptSuffix(topicCard)
          )
        }
      );
      logDebugTiming("topicPipeline.generateReviewedDraft", "writer_done", {
        publishJobId: input.publishJobId,
        topicCardId: input.topicCardId,
        attempt: attempt + 1,
        elapsedMs: getElapsedMs(attemptStartedAt)
      });

      const writerContent =
        typeof writerOutput.content === "string" ? writerOutput.content.trim() : "";
      if (writerContent.length < 300) {
        await this.topicRepository.createDraft(
          input.topicCardId,
          "raw",
          writerContent,
          writerOutput.summary ?? "",
          JSON.stringify({
            ...writerOutput,
            topicCard,
            blockedBeforeHumanizer: "writer_content_too_short"
          })
        );
        revisionFeedback = [
          "上一版写作结果是空的，或明显太短。",
          "请在 JSON.content 里返回一篇完整、可发布的知乎回答。",
          "遵守选题卡 writing_plan、后端 case_research、软广指令和账号 Soul。",
          "不要返回占位文、向用户要输入，或解释自己在做什么。"
        ].join("\n");
        logDebugTiming("topicPipeline.generateReviewedDraft", "writer_too_short_retry", {
          publishJobId: input.publishJobId,
          topicCardId: input.topicCardId,
          attempt: attempt + 1,
          contentLength: writerContent.length,
          elapsedMs: getElapsedMs(attemptStartedAt)
        });
        continue;
      }

      await this.topicRepository.createDraft(
        input.topicCardId,
        "raw",
        writerContent,
        writerOutput.summary ?? "",
        JSON.stringify({
          ...writerOutput,
          topicCard
        })
      );

      await input.onStage?.("humanizing");
      const humanized = await this.humanizerService.humanize(writerContent, {
        publishJobId: input.publishJobId,
        stage: "humanizing",
        agentName: "writer_agent"
      });
      logDebugTiming("topicPipeline.generateReviewedDraft", "humanizer_done", {
        publishJobId: input.publishJobId,
        topicCardId: input.topicCardId,
        attempt: attempt + 1,
        elapsedMs: getElapsedMs(attemptStartedAt)
      });

      const humanizedDraftId = await this.topicRepository.createDraft(
        input.topicCardId,
        "humanized",
        humanized.content,
        writerOutput.summary ?? "",
        JSON.stringify({
          ...writerOutput,
          topicCard,
          humanizerNotes: humanized.notes
        })
      );

      const review = await this.reviewService.reviewContent(
        {
          content: humanized.content,
          topicSummary: String(topicCard.summary ?? ""),
          topicCard,
          softPromoDirective: resolveSoftPromoDirective(topicCard),
          pastContentFingerprints: input.pastContentFingerprints
        },
        promptSnapshot,
        {
          accountSoulMarkdown: input.accountSoulMarkdown,
          agentContextDocuments,
          onStage: async (stage) => {
            await input.onStage?.(stage);
          }
        }
      );
      logDebugTiming("topicPipeline.generateReviewedDraft", "review_done", {
        publishJobId: input.publishJobId,
        topicCardId: input.topicCardId,
        attempt: attempt + 1,
        decision: review.decision,
        elapsedMs: getElapsedMs(attemptStartedAt)
      });

      const reviewId = await this.topicRepository.createReview({
        draftId: humanizedDraftId,
        reviewStatus: review.decision.toLowerCase(),
        hardGateJson: JSON.stringify(review.hardGate),
        editorialReviewJson: JSON.stringify(review.editorial),
        publishReviewJson: JSON.stringify(review.publish),
        topicDuplicationJson: JSON.stringify(topicCard.topic_fingerprint ?? {}),
        contentDuplicationJson: JSON.stringify({
          duplicateReason: review.publish.duplicate_reason ?? "",
          matchedPastContents: review.publish.matched_past_contents ?? []
        }),
        approvedContent: review.approvedContent,
        reviewSummary: review.reviewSummary
      });

      if (review.decision === "PASS" && review.approvedContent) {
        logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_pass", {
          publishJobId: input.publishJobId,
          topicCardId: input.topicCardId,
          attempt: attempt + 1,
          elapsedMs: getElapsedMs(attemptStartedAt),
          totalElapsedMs: getElapsedMs(startedAt)
        });
        return {
          kind: "ready",
          title: String(writerOutput.title ?? input.candidateTitle),
          topicCardId: input.topicCardId,
          reviewId,
          approvedContent: review.approvedContent,
          promptVersionSnapshotJson: JSON.stringify(promptSnapshot)
        };
      }

      if (review.decision === "BLOCK_DUPLICATION") {
        logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_duplicate", {
          publishJobId: input.publishJobId,
          topicCardId: input.topicCardId,
          attempt: attempt + 1,
          elapsedMs: getElapsedMs(attemptStartedAt),
          totalElapsedMs: getElapsedMs(startedAt)
        });
        return {
          kind: "duplicate",
          reason: review.publish.duplicate_reason ?? "content duplication detected during publish review"
        };
      }

      if (review.decision === "BLOCK") {
        logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_blocked", {
          publishJobId: input.publishJobId,
          topicCardId: input.topicCardId,
          attempt: attempt + 1,
          reason: review.reviewSummary || "content blocked by review",
          elapsedMs: getElapsedMs(attemptStartedAt),
          totalElapsedMs: getElapsedMs(startedAt)
        });
        return {
          kind: "blocked",
          reason: review.reviewSummary || "content blocked by review"
        };
      }

      if (review.quality.manualReviewReasons.length > 0 && attempt >= 2) {
        logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_needs_manual_review", {
          publishJobId: input.publishJobId,
          topicCardId: input.topicCardId,
          attempt: attempt + 1,
          reasons: review.quality.manualReviewReasons,
          elapsedMs: getElapsedMs(attemptStartedAt),
          totalElapsedMs: getElapsedMs(startedAt)
        });
        return {
          kind: "blocked",
          reason: buildManualReviewReason(review.quality.manualReviewReasons, review.reviewSummary),
          needsManualReview: Boolean(input.publishJobId)
        };
      }

      revisionFeedback = review.quality.rewriteBrief || review.editorial.rewrite_brief || review.reviewSummary;
      logDebugTiming("topicPipeline.generateReviewedDraft", "attempt_revise", {
        publishJobId: input.publishJobId,
        topicCardId: input.topicCardId,
        attempt: attempt + 1,
        elapsedMs: getElapsedMs(attemptStartedAt),
        totalElapsedMs: getElapsedMs(startedAt)
      });
    }

    logDebugTiming("topicPipeline.generateReviewedDraft", "rewrite_limit_reached", {
      publishJobId: input.publishJobId,
      topicCardId: input.topicCardId,
      elapsedMs: getElapsedMs(startedAt)
    });
    return {
      kind: "blocked",
      reason: `???? ${MAX_REWRITE_ATTEMPTS} ?????????????`,
      needsManualReview: Boolean(input.publishJobId)
    };

  }

  private async attachCaseResearchToTopicCard(input: {
    questionTitle: string;
    questionUrl?: string | null;
    topicCard: TopicAgentOutput | Record<string, unknown>;
    sourceContext?: Record<string, unknown> | null;
  }): Promise<TopicAgentOutput> {
    const existing = readRecord(input.topicCard.case_research);
    if (existing && typeof existing.should_use_case_research === "boolean") {
      return input.topicCard as TopicAgentOutput;
    }

    const research = await this.caseResearchService.research({
      questionTitle: input.questionTitle,
      questionUrl: input.questionUrl ?? null,
      topicCard: input.topicCard,
      sourceContext: input.sourceContext ?? null
    });

    if (!research.should_use_case_research && research.case_materials.length === 0) {
      return input.topicCard as TopicAgentOutput;
    }

    return {
      ...(input.topicCard as TopicAgentOutput),
      case_research: research
    };
  }
}

function buildManualReviewReason(reasons: string[], fallback: string) {
  const normalized = reasons.length ? reasons.join(", ") : "quality_review";
  return `???????????${normalized}${fallback ? `?${fallback}` : ""}`;
}

function buildTopicAgentFallback(questionTitle: string): TopicAgentOutput {
  return {
    title: questionTitle,
    summary: questionTitle,
    priority: "P2",
    fit_score: 60,
    question_type: "other",
    persona_mode: "default",
    target_audience: [],
    pain_points: [],
    recommended_angle: "",
    persona_hooks: [],
    soft_promo_mode: "none",
    soft_promo_reason: "",
    should_include_soft_promo: false,
    soft_promo_directive: buildSoftPromoDirective({
      shouldInclude: false,
      mode: "none",
      reason: "选题兜底结果未确认软广契合点。",
      productAnchor: ""
    }),
    writing_plan: buildFallbackWritingPlan(),
    must_avoid: [],
    risk_notes: [],
    topic_fingerprint: {
      problem_core: questionTitle,
      answer_angle: "",
      target_pain: "",
      promo_entry: "none"
    }
  };
}

function normalizeCachedTopicAgentOutput(value: unknown, questionTitle: string): TopicAgentOutput | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const priority = record.priority;
  if (priority !== "P0" && priority !== "P1" && priority !== "P2" && priority !== "SKIP") {
    return null;
  }

  return normalizeTopicAgentOutput(record, questionTitle);
}

function normalizeTopicAgentOutput(value: unknown, questionTitle: string): TopicAgentOutput {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallback = buildTopicAgentFallback(questionTitle);
  const priority = record.priority;
  const rawMode = normalizeSoftPromoMode(record.soft_promo_mode, fallback.soft_promo_mode);
  const explicitShouldInclude =
    typeof record.should_include_soft_promo === "boolean" ? record.should_include_soft_promo : null;
  const shouldInclude = explicitShouldInclude ?? (rawMode === "light" || rawMode === "natural");
  const softPromoMode = shouldInclude ? (rawMode === "none" ? "light" : rawMode) : "none";

  const fingerprint =
    record.topic_fingerprint && typeof record.topic_fingerprint === "object"
      ? (record.topic_fingerprint as Record<string, unknown>)
      : {};

  const softPromoReason =
    typeof record.soft_promo_reason === "string" && record.soft_promo_reason.trim()
      ? record.soft_promo_reason.trim()
      : shouldInclude
        ? "该选题与产品真实能力存在自然承接点。"
        : "该选题不适合强制加入软广。";

  const rawPromoEntry = typeof fingerprint.promo_entry === "string" ? fingerprint.promo_entry.trim() : "";
  const productAnchor = shouldInclude && rawPromoEntry && rawPromoEntry !== "none" ? rawPromoEntry : "";
  const softPromoDirective = normalizeSoftPromoDirective(record.soft_promo_directive, {
    shouldInclude,
    mode: softPromoMode,
    reason: softPromoReason,
    productAnchor
  });

  const normalized: TopicAgentOutput = {
    ...fallback,
    title: typeof record.title === "string" && record.title.trim() ? record.title : questionTitle,
    summary: typeof record.summary === "string" && record.summary.trim() ? record.summary : questionTitle,
    priority: priority === "P0" || priority === "P1" || priority === "P2" || priority === "SKIP" ? priority : fallback.priority,
    fit_score: normalizeFitScore(record.fit_score, fallback.fit_score),
    question_type:
      typeof record.question_type === "string" && record.question_type.trim() ? record.question_type : fallback.question_type,
    persona_mode:
      typeof record.persona_mode === "string" && record.persona_mode.trim() ? record.persona_mode : fallback.persona_mode,
    target_audience: normalizeStringArray(record.target_audience),
    pain_points: normalizeStringArray(record.pain_points),
    recommended_angle: typeof record.recommended_angle === "string" ? record.recommended_angle : fallback.recommended_angle,
    persona_hooks: normalizeStringArray(record.persona_hooks),
    soft_promo_mode: softPromoMode,
    soft_promo_reason: softPromoReason,
    should_include_soft_promo: shouldInclude,
    soft_promo_directive: softPromoDirective,
    writing_plan: normalizeWritingPlan(record.writing_plan, fallback.writing_plan),
    must_avoid: normalizeStringArray(record.must_avoid),
    risk_notes: normalizeStringArray(record.risk_notes),
    topic_fingerprint: {
      problem_core:
        typeof fingerprint.problem_core === "string" && fingerprint.problem_core.trim()
          ? fingerprint.problem_core
          : questionTitle,
      answer_angle: typeof fingerprint.answer_angle === "string" ? fingerprint.answer_angle : "",
      target_pain: typeof fingerprint.target_pain === "string" ? fingerprint.target_pain : "",
      promo_entry: shouldInclude ? rawPromoEntry || softPromoDirective.product_anchor || "待 Writer 自然确认" : "none"
    }
  };

  normalized.writing_plan = applyCaseDrivenWritingPlanDefaults(
    normalized.writing_plan,
    [
      questionTitle,
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

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
  if (existing.includes("案例驱动默认") || existing.includes("Case-driven default")) {
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
  const normalizedMin = Math.min(min, max);
  const normalizedMax = Math.max(min, max);
  const caseStyle =
    record.case_style === "typical_composite" ||
    record.case_style === "personal_reflection" ||
    record.case_style === "contrast_cases" ||
    record.case_style === "none"
      ? record.case_style
      : fallback.case_style;

  return {
    length_mode: lengthMode,
    target_words_min: normalizedMin,
    target_words_max: normalizedMax,
    structure_mode:
      typeof record.structure_mode === "string" && record.structure_mode.trim()
        ? record.structure_mode.trim()
        : fallback.structure_mode,
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
    suggested_sections: normalizeStringArray(record.suggested_sections).length
      ? normalizeStringArray(record.suggested_sections).slice(0, 10)
      : fallback.suggested_sections,
    writer_notes:
      typeof record.writer_notes === "string" && record.writer_notes.trim()
        ? record.writer_notes.trim()
        : fallback.writer_notes
  };
}

function normalizeWordCount(value: unknown, fallback: number, maxValue = 5000) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(400, Math.min(maxValue, Math.round(numeric)));
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
  return value === "light" || value === "natural" || value === "none" ? value : fallback;
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
  const reason =
    typeof record.reason === "string" && record.reason.trim() ? record.reason.trim() : fallback.reason;
  const productAnchor =
    typeof record.product_anchor === "string" && record.product_anchor.trim()
      ? record.product_anchor.trim()
      : fallback.productAnchor;
  const writerInstruction =
    typeof record.writer_instruction === "string" && record.writer_instruction.trim()
      ? record.writer_instruction.trim()
      : buildSoftPromoWriterInstruction({ shouldInclude, mode, reason, productAnchor });

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

function resolveSoftPromoDirective(topicCard: Record<string, unknown>) {
  return normalizeSoftPromoDirective(topicCard.soft_promo_directive, {
    shouldInclude:
      typeof topicCard.should_include_soft_promo === "boolean"
        ? topicCard.should_include_soft_promo
        : topicCard.soft_promo_mode === "light" || topicCard.soft_promo_mode === "natural",
    mode: typeof topicCard.soft_promo_mode === "string" ? topicCard.soft_promo_mode : "none",
    reason: typeof topicCard.soft_promo_reason === "string" ? topicCard.soft_promo_reason : "",
    productAnchor:
      topicCard.topic_fingerprint &&
      typeof topicCard.topic_fingerprint === "object" &&
      typeof (topicCard.topic_fingerprint as Record<string, unknown>).promo_entry === "string"
        ? String((topicCard.topic_fingerprint as Record<string, unknown>).promo_entry)
        : ""
  });
}

function buildTopicAgentSingleSelectionPromptSuffix() {
  return [
    "案例规划：GPT / Claude Code 接入、API 中转/代理选型、成本控制、工具选型、AI 辅助编程工作流题，默认 writing_plan.should_use_cases=true，除非只是极窄定义题。",
    "案例保留：如果 sourceContext、后端 case_research、用户备注、标题或候选上下文里有具体项目故事、接入失败或迁移踩坑，写进 recommended_angle 或 writing_plan.writer_notes，留给写作 Agent。",
    "案例质量：可用案例必须包含项目背景（个人项目/小团队/创业）、用了哪些模型、具体卡点（限流、超时、账单惊吓、迁移需求、访问不稳）、试过什么、最终怎么选、还剩什么局限。",
    "案例多样性：用户给的范文只是文风/质量参考，不是可复用原文。不要在不同回答里反复用同一个项目故事、同一个模型名或同一套措辞。",
    "Topic Agent 单题最终选题补充规则：",
    "1. 必须认真使用 product.md、target.md 和 Account Soul，不要只按固定关键词判断选题价值。",
    "2. Topic Agent 需要自主判断题目是否适合当前账号，但内容重心必须更多放在实际使用/想用 GPT、Claude Code 的开发者身上：官方接口访问不稳定、限流报错、账单/计费问题、接入方式选型、迁移评估、AI 辅助编程的实际使用体验。",
    "3. 在方向符合时，尽可能选择流量更高的问题：痛点更大众、讨论空间更大、搜索需求更稳定、标题更像真实用户会点的问题，应优先于很冷、很窄、很工程化的问题。",
    "4. 工具对比/选型类题可以选，也可以加入软广。承接点是官方直连 vs 中转/代理的取舍、怎么判断中转服务是否可信，不要写成产品测评合集。",
    "5. AI 辅助编程类题可以选，也可以加入软广。承接点是怎么把 Claude Code / GPT 用得更顺手、更稳定、更省钱；严禁暗示某个中转服务能保证 100% 可用或能绕过官方限制。",
    "6. 不要把纯理论科普题（大模型原理、Prompt 工程理论、行业新闻）作为主要选题方向，除非能自然承接到访问/成本/稳定性的具体痛点。",
    "7. 泛开发者工具心态题可以选，例如怎么选编程助手、怎么看代码生成质量这类题；但它们更适合作为纯经验分享，不要默认加入 Dudu 中转站。",
    "8. 对泛开发者工具心态题，除非题目明确问 API 访问、成本控制或中转/代理服务，否则 should_include_soft_promo=false，soft_promo_mode=none，topic_fingerprint.promo_entry=none。",
    "9. 软广需要有节奏，不要每一篇都带。整体按约 10 条里 7 条自然带产品、3 条纯分享/纯经验/纯观点来控制。",
    "10. 即使题目能勉强接到产品，只要它更适合做人设信任、开发心得、踩坑经验或工具常识，就应优先留白：should_include_soft_promo=false。",
    "11. 不要让纯理论题天然优先；如果访问/成本/稳定性/工具选型题更符合账号 Soul 和读者痛点，可以给更高 priority 和 fit_score。",
    "12. 选题结束后，必须单独判断这个选题是否适合自然加入软广。",
    "13. 如果适合，把 should_include_soft_promo 设为 true，soft_promo_mode 设为 light 或 natural，并在 soft_promo_directive.writer_instruction 里明确告诉 Writer：这篇需要自然加入 Dudu 中转站。",
    "14. 如果不适合，把 should_include_soft_promo 设为 false，soft_promo_mode 设为 none，topic_fingerprint.promo_entry 写 none，并在 soft_promo_directive.writer_instruction 里明确告诉 Writer：这篇不强制加入软广，不要硬带 Dudu 中转站。",
    "15. 只有当 Dudu 中转站的真实能力能解决题目里的具体一步时，才允许 should_include_soft_promo=true；不要因为业务目标需要推广就默认每篇都带。",
    "16. 必须输出 writing_plan，由 Topic Agent 决定正文长度、是否需要案例、是否需要算账、是否适合列表/短标题、哪些重点需要加粗。",
    "17. length_mode 选择规则：简单知识问答用 short；普通方法题用 standard；开发经历、弯路复盘、新手入门、成本优化、工具选型方法论、软文承接空间大的题用 long。",
    "18. 字数规则：target_words_min 是 Writer 必须达到的硬下限；target_words_max 只是软参考，可以超过，不能为了压字数牺牲案例、算账和信息密度。",
    "19. 案例规则：只有题目适合故事化时 should_use_cases=true；没有真实输入证据时 case_style 用 typical_composite 或 contrast_cases，可以要求 Writer 写接近真实的复合案例，但不要要求伪造真实项目经历。",
    "20. 数据规则：案例里的调用量、并发数、月账单、限流次数等数字要贴近真实开发场景常识、保守且自洽，不要要求精确历史统计。",
    "21. 算账规则：涉及成本预算、调用量、方案选型的性价比时 should_include_calculation=true。",
    "22. 加粗规则：standard/long 文章默认 should_use_bold=true，bold_targets 应指定 2-5 类重点，如核心结论、风险边界、成本结论、操作原则、产品边界。",
    "23. suggested_sections 是结构提示，不是要求 Writer 原样使用的标题；避免反复输出“先说结论/最后补一句”这类固定模板。",
    "24. 只输出 JSON，不要 Markdown。",
    "单题输出格式必须包含以下字段：",
    "{",
    '  "title": "建议标题",',
    '  "summary": "100-180字选题摘要",',
    '  "priority": "P0 | P1 | P2 | SKIP",',
    '  "fit_score": 0,',
    '  "question_type": "工具推荐 | 方法验证 | 入门认知 | 选型对比 | 成本优化 | 稳定性排查 | 纯干货 | 其他",',
    '  "persona_mode": "二牛实测型 | 二牛踩坑型 | 二牛对比型 | 二牛经验型",',
    '  "target_audience": ["目标读者1"],',
    '  "pain_points": ["痛点1"],',
    '  "recommended_angle": "最适合切入的写法",',
    '  "persona_hooks": ["适合强化人设的细节"],',
    '  "soft_promo_mode": "none | light | natural",',
    '  "soft_promo_reason": "为什么适合或不适合自然植入",',
    '  "should_include_soft_promo": false,',
    '  "soft_promo_directive": {',
    '    "should_include": false,',
    '    "mode": "none | light | natural",',
    '    "reason": "选题层面的软广适配判断",',
    '    "product_anchor": "适合植入时写具体承接点，不适合写空字符串",',
    '    "writer_instruction": "给 Writer 的明确执行指令"',
    "  },",
    '  "writing_plan": {',
    '    "length_mode": "short | standard | long",',
    '    "target_words_min": 900,',
    '    "target_words_max": 1300,',
    '    "structure_mode": "例如：开头判断 + 典型案例 + 算账 + 具体做法 + 克制收口",',
    '    "should_use_cases": false,',
    '    "case_style": "none | typical_composite | personal_reflection | contrast_cases",',
    '    "should_include_calculation": false,',
    '    "should_include_list": false,',
    '    "should_use_bold": true,',
    '    "bold_targets": ["核心结论", "风险边界", "算账结论"],',
    '    "suggested_sections": ["开头判断", "典型情况", "算账段", "具体做法", "克制收口"],',
    '    "writer_notes": "给 Writer 的长度、案例和结构执行提醒"',
    "  },",
    '  "must_avoid": ["绝对不能写的点"],',
    '  "risk_notes": ["平台风险或理解风险"],',
    '  "topic_fingerprint": {',
    '    "problem_core": "问题本质",',
    '    "answer_angle": "回答角度",',
    '    "target_pain": "目标用户痛点",',
    '    "promo_entry": "软广切入口，没有就写 none"',
    "  }",
    "}"
  ].join("\n");
}

function buildWriterSoftPromoPromptSuffix(topicCard: Record<string, unknown>) {
  const directive = resolveSoftPromoDirective(topicCard);
  if (directive.should_include) {
    return [
      "选题 Agent 软广指令：",
      "1. 选题 Agent 判断这道已选题适合自然软广。",
      "2. 正文必须自然出现 Dudu 中转站，但仍然要先把知乎问题回答完整。",
      "3. 只在适合的位置用产品：官方访问不稳、成本控制、迁移，或中转/代理选型。",
      "4. 不要写成硬广、功能清单、保证话术或夸大宣称。",
      "5. 如果题目天然涉及 API 访问、成本或工具选型，优先用工作流式软提：真正合适时简短提 1-2 个广为人知的同类方案（如 OpenRouter，或自建中转 New API / LiteLLM），再说清楚为什么 Dudu 中转站更适合这一步访问/成本问题。",
      "6. 不要贬低同类工具，不要编造对比，不要声称能绕过官方限制。同类工具只当真实工作流对照。",
      "7. 正文、标题、摘要都不要出现 api.dududu.cloud、dududu.cloud。https 链接不要写进中间段落。产品段必须有且仅有 1 句 **加粗** 引导，点名文末 GitHub 仓库 「router-list」，并写清打开后看费率、手动教程或 CC Switch 中与本题最相关的一项。文末单独加「参考文献」，链接上方加粗说明，只放一次 https://github.com/hehesama527/router-list 。",
      `8. 选题原因：${directive.reason || "未提供"}`,
      directive.product_anchor ? `9. 产品承接点：${directive.product_anchor}` : null,
      `10. 给写作 Agent 的指令：${directive.writer_instruction}`
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "选题 Agent 软广指令：",
    "1. 选题 Agent 判断这道已选题不适合强制软广。",
    "2. 不要只为了完成推广目标而硬加 Dudu 中转站。",
    "3. 正常回答知乎问题。如果不提产品答案更强，就不要提。也不要加 GitHub 参考文献。",
    `4. 选题原因：${directive.reason || "未提供"}`,
    `5. 给写作 Agent 的指令：${directive.writer_instruction}`
  ].join("\n");
}

function buildWriterCaseResearchPromptSuffix(topicCard: Record<string, unknown>) {
  const research = readRecord(topicCard.case_research);
  if (!research) {
    return [
      "后端案例研究：",
      "这道题没有附带后端 case_research 材料。",
      "如果写作计划要求案例，请写接近真实、数字自洽的典型/复合案例，不要写成已验证的真实事件或个人记录。"
    ].join("\n");
  }

  const materials = Array.isArray(research.case_materials)
    ? research.case_materials
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 4)
    : [];

  return [
    "后端案例研究：",
    JSON.stringify(
      {
        should_use_case_research: research.should_use_case_research === true,
        research_summary: typeof research.research_summary === "string" ? research.research_summary : "",
        writer_guidance: typeof research.writer_guidance === "string" ? research.writer_guidance : "",
        must_not_claim: Array.isArray(research.must_not_claim) ? research.must_not_claim : [],
        case_materials: materials.map((item) => ({
          case_label: item.case_label,
          source_type: item.source_type,
          source_label: item.source_label,
          source_url: item.source_url,
          time_or_period: item.time_or_period,
          price_or_market_path: item.price_or_market_path,
          retail_entry_trigger: item.retail_entry_trigger,
          risk_mechanism: item.risk_mechanism,
          outcome_pressure: item.outcome_pressure,
          usable_angle: item.usable_angle,
          confidence: item.confidence,
          caution: item.caution
        }))
      },
      null,
      2
    ),
    "后端 case_research 写作规则：",
    "1. 写作计划要求案例时优先用这些材料，但不要机械粘贴。",
    "2. 高/中置信度的 rss、market、source_context 材料可以当谨慎证据。低置信度或 composite_hint 材料必须写成常见模式例子，不能写成已验证事实。",
    "3. 不要抄来源原文。用第一人称分析口吻，按完整动作链重写案例。",
    "4. 不要把用户给的参考案例当成每道题的默认案例。",
    "5. 如果附带材料弱或跑题，少写具体事件，改用数字自洽的复合案例。"
  ].join("\n");
}

function buildWriterWritingPlanPromptSuffix(topicCard: Record<string, unknown>) {
  const plan = normalizeWritingPlan(topicCard.writing_plan, buildFallbackWritingPlan());
  const lines = [
    "选题 Agent 写作计划：",
    "1. 这道题的篇幅、结构、是否用案例、是否算账、是否用列表，由选题 Agent 决定。",
    "2. 除非和硬安全边界、账号 Soul 或软广指令直接冲突，否则按这个计划写。",
    `3. length_mode: ${plan.length_mode}`,
    `4. 目标字数：至少 ${plan.target_words_min} 个汉字；${plan.target_words_max} 只是软参考，不是硬上限。`,
    `5. structure_mode: ${plan.structure_mode}`,
    `6. should_use_cases: ${plan.should_use_cases}`,
    `7. case_style: ${plan.case_style}`,
    `8. should_include_calculation: ${plan.should_include_calculation}`,
    `9. should_include_list: ${plan.should_include_list}`,
    `10. should_use_bold: ${plan.should_use_bold}`,
    `11. bold_targets: ${plan.bold_targets.join(" / ")}`,
    `12. suggested_sections: ${plan.suggested_sections.join(" / ")}`,
    `13. writer_notes: ${plan.writer_notes}`,
    "14. target_words_min 是硬下限。需要更多案例、算账或具体细节时，可以超过 target_words_max。",
    "15. 如果 should_use_bold=true，用 **...** 加粗 2 到 4 处关键结论、风险边界、算账结论或操作原则。不要整段加粗。",
    "16. 需要案例但没有已验证真实案例时，写接近真实、数据合理的典型/复合案例；不要写成已验证的真实朋友或真实个人记录。",
    "17. 开发/API 接入/工具选题里，案例要承担论证，不要当装饰。动作链包含：项目背景、具体卡点（限流、超时、账单、迁移需求）、试过什么、最终怎么选、还剩什么局限。",
    "18. 如果输入/题目上下文里有具体来源案例，可以用谨慎说法作为证据，例如“按这条路径看”“类似情况里”；不要声称自己核实过，也不要和安全或事实冲突。",
    "19. 不要抄用户给的参考原文，也不要把一个参考案例当成每道题的默认例子。",
    "20. 不同回答优先用不同案例。用后端 case_research、来源上下文，或贴合这道题的新复合案例。",
    "21. 如果没有具体案例，就写接近真实、数字自洽、明确是常见模式的典型/复合案例。",
    "22. suggested_sections 只是结构提示，不是必须原样使用的标题。同类题要变化开头和结尾。",
    "23. 用场景、算账、反例、步骤和阶段建议增加实质内容，不要为了凑字数重复同一个观点。"
  ];

  return lines.join("\n");
}
