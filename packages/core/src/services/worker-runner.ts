import type { FailureType, JobDetail, JobListItem, JobStage, PromptSnapshotMap, WorkerTickSummary } from "@zhihu-mvp/shared";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AccountRepository } from "../repositories/account-repository.js";
import { JobRepository } from "../repositories/job-repository.js";
import { ScheduleRepository } from "../repositories/schedule-repository.js";
import { TopicRepository } from "../repositories/topic-repository.js";
import { getElapsedMs, logDebugTiming } from "../utils/debug-timing.js";
import { safeParseJson } from "../utils/json.js";
import { hasManualLoginLock } from "../utils/manual-login-lock.js";
import { isRetryableLockError } from "../utils/mysql-retry.js";
import { withTimeoutReject } from "../utils/with-timeout.js";
import { AccountSoulService } from "./account-soul-service.js";
import { FeishuNotificationService } from "./feishu-notification-service.js";
import { FailureResolutionService } from "./failure-resolution-service.js";
import { LlmService } from "./llm-service.js";
import { OpsIncidentService } from "./ops-incident-service.js";
import { PublishFlowError, PublishService, type PublishResumeAnchor } from "./publish-service.js";
import { ScheduleService } from "./schedule-service.js";
import { SessionStateError } from "./session-service.js";
import type { AccountPromptContext } from "./account-prompt-context.js";
import { TopicDiscoveryService } from "./topic-discovery-service.js";
import {
  planTopicAssignments,
  SHARED_TOPIC_BATCH_SIZE,
  shouldHarvestSharedTopicBatch
} from "./topic-harvest-assign.js";
import { TopicPipelineService } from "./topic-pipeline-service.js";

type TickBranchResult = {
  blockedByLogin: boolean;
  message: string | null;
};

type PrepareJobResult = {
  prepared: boolean;
  blockedByLogin: boolean;
  message: string | null;
};

type WorkerAccount = NonNullable<Awaited<ReturnType<AccountRepository["getAccount"]>>>;
const MAX_PREPARE_CONCURRENCY = 3;
const MAX_PREPARE_JOBS_PER_ACCOUNT = 1;
const PREPARE_CANDIDATE_FETCH_LIMIT = 30;
const PREPARE_WINDOW_MINUTES = 120;
const PUBLISH_ATTEMPT_TIMEOUT_MS = 600_000;
const HARVEST_TIMEOUT_MS = 8 * 60 * 1000;
const CHALLENGE_PAGE_KEEP_OPEN_MS = 15 * 60 * 1000;

export class WorkerRunner {
  private readonly accountSoulService = new AccountSoulService();
  private readonly inFlightPrepareJobs = new Map<number, { accountId: number; promise: Promise<void> }>();

  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly scheduleRepository: ScheduleRepository,
    private readonly accountRepository: AccountRepository,
    private readonly topicRepository: TopicRepository,
    private readonly topicDiscoveryService: TopicDiscoveryService,
    private readonly topicPipelineService: TopicPipelineService,
    private readonly jobRepository: JobRepository,
    private readonly publishService: PublishService,
    private readonly failureResolutionService: FailureResolutionService,
    private readonly llmService: LlmService,
    private readonly feishuNotificationService: FeishuNotificationService,
    private readonly opsIncidentService?: OpsIncidentService
  ) {}

  async tick(): Promise<WorkerTickSummary> {
    const tickStartedAt = Date.now();
    logDebugTiming("worker.tick", "start");

    const generatedSlots = await this.scheduleService.bootstrapTodaySchedule();
    const accounts = await this.accountRepository.listAccounts();
    if (!accounts.length) {
      throw new Error("没有可运行账号，无法启动 Worker。");
    }

    const accountsById = new Map<number, WorkerAccount>(accounts.map((account) => [account.id, account]));
    const blockedAccountIds = new Set<number>();
    const blockedMessages: string[] = [];
    const runnableAccounts: WorkerAccount[] = [];

    for (const account of accounts) {
      const manualLoginLocked = await hasManualLoginLock(account.id);
      if (isLoginBlockedAccount(account) || manualLoginLocked || isCoolingDown(account)) {
        blockedAccountIds.add(account.id);
        blockedMessages.push(resolveAccountBlockMessage(account, { manualLoginLocked }));
        continue;
      }

      runnableAccounts.push(account);
    }

    for (const account of runnableAccounts) {
      if (!account.profileDir) {
        continue;
      }

      await this.fillScheduleSlots(account);
    }
    logDebugTiming("worker.tick", "filled_schedule_slots", {
      elapsedMs: getElapsedMs(tickStartedAt),
      runnableAccounts: runnableAccounts.length
    });

    const dueJobs = await this.jobRepository.getDueJobs();
    logDebugTiming("worker.tick", "loaded_due_jobs", {
      elapsedMs: getElapsedMs(tickStartedAt),
      dueJobs: dueJobs.map((job) => ({ id: job.id, status: job.status, scheduledAt: job.scheduledAt }))
    });
    const processResult = await this.processDueJobs(
      dueJobs,
      accountsById,
      blockedAccountIds,
      blockedMessages
    );
    logDebugTiming("worker.tick", "processed_due_jobs", {
      elapsedMs: getElapsedMs(tickStartedAt),
      processedJobs: processResult.processedJobs
    });

    const reopenedLockFailures = await this.scheduleRepository.reopenRetryableLockFailedSlots();
    if (reopenedLockFailures > 0) {
      console.warn("[worker] reopened deadlock-failed slots", { count: reopenedLockFailures });
    }

    const emptyPoolAccountIds = await this.listEmptyPoolAccountIds(runnableAccounts, blockedAccountIds);
    const prepareResult = await this.kickPrepareQueuedJobs(accountsById, blockedAccountIds, emptyPoolAccountIds);
    logDebugTiming("worker.tick", "kicked_prepare", {
      elapsedMs: getElapsedMs(tickStartedAt),
      preparedJobs: prepareResult.preparedJobs,
      inFlightPrepareJobs: prepareResult.inFlightPrepareJobs,
      emptyPoolAccounts: emptyPoolAccountIds.size,
      blockedAccounts: blockedAccountIds.size
    });

    const harvestedCandidates = await this.harvestSharedTopicBatch(
      runnableAccounts,
      accountsById,
      blockedAccountIds,
      blockedMessages
    );
    logDebugTiming("worker.tick", "finished_shared_harvest", {
      elapsedMs: getElapsedMs(tickStartedAt),
      harvestedCandidates
    });
    const blockedByLogin = blockedAccountIds.size > 0;

    const summary = {
      generatedSlots,
      harvestedCandidates,
      preparedJobs: prepareResult.preparedJobs,
      inFlightPrepareJobs: prepareResult.inFlightPrepareJobs,
      processedJobs: processResult.processedJobs,
      blockedByLogin,
      accountStatus: resolveTickAccountStatus(accounts.length, blockedAccountIds.size),
      message: buildBlockedSummary(accounts.length, blockedAccountIds.size, blockedMessages)
    };

    logDebugTiming("worker.tick", "done", {
      elapsedMs: getElapsedMs(tickStartedAt),
      summary
    });

    return summary;
  }

  async runJobNow(jobId: number): Promise<{
    prepared: boolean;
    processed: boolean;
    blockedByLogin: boolean;
    message: string | null;
    job: JobDetail | null;
  }> {
    const job = await this.jobRepository.getJobById(jobId);
    if (!job) {
      throw new Error("任务不存在。");
    }

    const account = await this.accountRepository.getAccount(job.accountId);
    if (!account) {
      throw new Error("任务对应账号不存在。");
    }
    if (!account.profileDir) {
      throw new Error("账号缺少浏览器 profile，无法立即执行。");
    }

    const manualLoginLocked = await hasManualLoginLock(account.id);
    if (manualLoginLocked || isLoginBlockedAccount(account) || isCoolingDown(account)) {
      return {
        prepared: false,
        processed: false,
        blockedByLogin: true,
        message: resolveAccountBlockMessage(account, { manualLoginLocked }),
        job
      };
    }

    const preparationStatuses = new Set<JobDetail["status"]>([
      "queued",
      "topic_discovery",
      "topic_agent",
      "topic_review",
      "writer",
      "humanizing",
      "review_hard_gate",
      "review_editorial",
      "review_publish"
    ]);
    const runnableStatuses = new Set<JobDetail["status"]>([
      "review_passed",
      "login_checking",
      "publishing",
      "publish_verify",
      "retry_waiting",
      "manual_login_required"
    ]);

    let prepared = false;
    let latestJob: JobDetail | null = job;

    if (preparationStatuses.has(job.status)) {
      const prepareResult = await this.prepareJob(job, account);
      prepared = prepareResult.prepared;
      latestJob = await this.jobRepository.getJobById(jobId);
      if (prepareResult.blockedByLogin) {
        return {
          prepared,
          processed: false,
          blockedByLogin: true,
          message: prepareResult.message,
          job: latestJob
        };
      }
    }

    latestJob = await this.jobRepository.getJobById(jobId);
    if (!latestJob) {
      return {
        prepared,
        processed: false,
        blockedByLogin: false,
        message: "任务在执行过程中已不存在。",
        job: null
      };
    }

    if (!runnableStatuses.has(latestJob.status)) {
      return {
        prepared,
        processed: false,
        blockedByLogin: false,
        message: `任务当前状态为 ${latestJob.status}，暂不需要立即发布执行。`,
        job: latestJob
      };
    }

    const latestAccount = await this.accountRepository.getAccount(latestJob.accountId);
    if (!latestAccount || !latestAccount.profileDir) {
      throw new Error("任务对应账号缺少可用浏览器 profile。");
    }

    const result = await this.executeJob(latestJob, latestAccount as WorkerAccount);
    return {
      prepared,
      processed: true,
      blockedByLogin: result.blockedByLogin,
      message: result.message,
      job: await this.jobRepository.getJobById(jobId)
    };
  }

  async waitForInFlightPrepares() {
    await Promise.allSettled(
      [...this.inFlightPrepareJobs.values()].map((entry) => entry.promise)
    );
  }

  async closeAllSessions() {
    await this.publishService.closeAllSessions();
  }

  private async fillScheduleSlots(account: WorkerAccount) {
    const startedAt = Date.now();
    let createdJobs = 0;
    const soulDocument = await this.ensureAccountSoulDocument(account);

    while (true) {
      const slot = await this.scheduleService.getNextUnassignedSlot(account.id);
      if (!slot) {
        break;
      }

      const promptSnapshot = await this.llmService.getPromptSnapshotForAccount({
        writerPromptVersionId: await this.resolveWriterPromptVersionId(account)
      });
      const promptSnapshotJson = JSON.stringify(promptSnapshot);

      const jobId = await this.jobRepository.createQueuedJob({
        accountId: account.id,
        scheduledAt: slot.scheduledAt,
        promptVersionSnapshotJson: promptSnapshotJson,
        soulVersion: soulDocument.version,
        soulMarkdownSnapshot: soulDocument.markdown
      });
      const assigned = await this.scheduleRepository.assignJobToSlot(slot.id, jobId);
      if (!assigned) {
        await this.jobRepository.deleteUnassignedQueuedJob(jobId);
        continue;
      }
      createdJobs += 1;
    }

    logDebugTiming("worker.fillScheduleSlots", "done", {
      accountId: account.id,
      createdJobs,
      elapsedMs: getElapsedMs(startedAt)
    });

    return createdJobs;
  }

  private async listEmptyPoolAccountIds(accounts: WorkerAccount[], blockedAccountIds: Set<number>) {
    const emptyPoolAccountIds = new Set<number>();
    for (const account of accounts) {
      if (blockedAccountIds.has(account.id)) {
        continue;
      }
      const activeCount = await this.topicRepository.countActiveCandidates(account.id);
      if (activeCount <= 0) {
        emptyPoolAccountIds.add(account.id);
      }
    }
    return emptyPoolAccountIds;
  }

  private async harvestSharedTopicBatch(
    accounts: WorkerAccount[],
    accountsById: Map<number, WorkerAccount>,
    blockedAccountIds: Set<number>,
    blockedMessages: string[]
  ): Promise<number> {
    const demand = await this.listTopicDemand(accounts, blockedAccountIds);
    const totalDemand = demand.reduce((sum, item) => sum + item.neededCount, 0);
    if (totalDemand <= 0) {
      return 0;
    }

    const accountIds = demand.map((item) => item.accountId);
    let holders = await this.topicRepository.listOpenCandidateHolders(accountIds);
    let assigned = await this.applyTopicAssignments(holders, demand);
    holders = await this.topicRepository.listOpenCandidateHolders(accountIds);

    const openByAccount = countHoldersByAccount(holders);
    const emptyDemandAccounts = demand.filter((item) => (openByAccount.get(item.accountId) ?? 0) <= 0).length;
    if (
      !shouldHarvestSharedTopicBatch({
        totalOpenCandidates: holders.length,
        totalDemand,
        emptyDemandAccounts,
        batchSize: SHARED_TOPIC_BATCH_SIZE
      })
    ) {
      return assigned;
    }

    const browserAccount = pickHarvestBrowserAccount(accounts, blockedAccountIds, demand);
    if (!browserAccount?.profileDir) {
      return assigned;
    }

    try {
      const harvestStartedAt = Date.now();
      const soulContext = await this.ensureAccountSoulDocument(browserAccount);
      console.warn("[worker] harvesting shared topic batch", {
        accountId: browserAccount.id,
        accountName: browserAccount.name,
        totalDemand,
        currentOpen: holders.length,
        distributeTo: accountIds
      });
      assigned += await withTimeoutReject(
        this.topicDiscoveryService.harvestCandidates({
          accountId: browserAccount.id,
          profileDir: browserAccount.profileDir,
          accountContext: toAccountPromptContext(browserAccount),
          accountSoulMarkdown: soulContext.markdown,
          fillSharedBatch: true
        }),
        HARVEST_TIMEOUT_MS,
        "共享采题超时，已释放浏览器并继续写稿。",
        () => this.publishService.closeAllSessions()
      );
      logDebugTiming("worker.tick", "shared_harvest_done", {
        accountId: browserAccount.id,
        elapsedMs: getElapsedMs(harvestStartedAt),
        harvestedCandidates: assigned
      });
    } catch (error) {
      if (error instanceof SessionStateError) {
        await this.pauseAccountForLogin(browserAccount.id, error.message, {
          failureType: mapSessionFailureType(error.sessionState),
          triggerStage: "topic_discovery"
        });
        blockedAccountIds.add(browserAccount.id);
        blockedMessages.push(error.message);
        accountsById.set(browserAccount.id, {
          ...browserAccount,
          status: "manual_login_required",
          statusReason: error.message
        });
        return assigned;
      }

      console.error("[worker] topic discovery failed", error);
      return assigned;
    }

    holders = await this.topicRepository.listOpenCandidateHolders(accountIds);
    assigned += await this.applyTopicAssignments(holders, demand);
    return assigned;
  }

  private async listTopicDemand(accounts: WorkerAccount[], blockedAccountIds: Set<number>) {
    const jobs = await this.jobRepository.getJobsNeedingPreparation(PREPARE_CANDIDATE_FETCH_LIMIT, {
      now: new Date(),
      withinMinutes: PREPARE_WINDOW_MINUTES
    });
    const demand = new Map<number, number>();
    for (const job of jobs) {
      if (blockedAccountIds.has(job.accountId)) {
        continue;
      }
      demand.set(job.accountId, (demand.get(job.accountId) ?? 0) + 1);
    }

    return accounts
      .filter((account) => (demand.get(account.id) ?? 0) > 0)
      .map((account) => ({
        accountId: account.id,
        neededCount: demand.get(account.id) ?? 0
      }));
  }

  private async applyTopicAssignments(
    holders: Array<{ id: number; accountId: number }>,
    demand: Array<{ accountId: number; neededCount: number }>
  ) {
    const assignments = planTopicAssignments({ candidates: holders, demand });
    let moved = 0;
    for (const assignment of assignments) {
      const ok = await this.topicRepository.reassignOpenCandidateAccount(assignment.candidateId, assignment.toAccountId);
      if (ok) {
        moved += 1;
      }
    }
    if (moved > 0) {
      console.warn("[worker] distributed shared topic batch", {
        moved,
        assignments: assignments.map((item) => ({
          candidateId: item.candidateId,
          fromAccountId: item.fromAccountId,
          toAccountId: item.toAccountId
        }))
      });
    }
    return moved;
  }

  private async kickPrepareQueuedJobs(
    accountsById: Map<number, WorkerAccount>,
    blockedAccountIds: Set<number>,
    emptyPoolAccountIds = new Set<number>()
  ): Promise<{ preparedJobs: number; inFlightPrepareJobs: number }> {
    const startedAt = Date.now();
    const availableSlots = Math.max(0, MAX_PREPARE_CONCURRENCY - this.inFlightPrepareJobs.size);
    if (availableSlots <= 0) {
      return {
        preparedJobs: 0,
        inFlightPrepareJobs: this.inFlightPrepareJobs.size
      };
    }

    const jobs = await this.jobRepository.getJobsNeedingPreparation(PREPARE_CANDIDATE_FETCH_LIMIT, {
      now: new Date(),
      withinMinutes: PREPARE_WINDOW_MINUTES
    });
    const selected = selectAccountScopedPrepareJobs({
      jobs,
      accountsById,
      blockedAccountIds,
      inFlightJobIds: new Set(this.inFlightPrepareJobs.keys()),
      inFlightAccountIds: new Set([...this.inFlightPrepareJobs.values()].map((entry) => entry.accountId)),
      skipAccountIds: emptyPoolAccountIds,
      limit: availableSlots
    });

    logDebugTiming("worker.kickPrepareQueuedJobs", "selected_jobs", {
      elapsedMs: getElapsedMs(startedAt),
      availableSlots,
      candidateJobs: jobs.map((job) => ({ id: job.id, accountId: job.accountId, status: job.status, scheduledAt: job.scheduledAt })),
      selectedJobs: selected.map(({ job }) => ({ id: job.id, accountId: job.accountId, scheduledAt: job.scheduledAt }))
    });

    for (const { job, account } of selected) {
      const promise = this.prepareJob(job, account)
        .catch((error) => {
          console.error("[worker] background prepare failed", {
            jobId: job.id,
            accountId: job.accountId,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .then(() => undefined);
      this.inFlightPrepareJobs.set(job.id, { accountId: job.accountId, promise });
      void promise.finally(() => {
        this.inFlightPrepareJobs.delete(job.id);
      });
    }

    return {
      preparedJobs: selected.length,
      inFlightPrepareJobs: this.inFlightPrepareJobs.size
    };
  }

  private async prepareJob(job: JobListItem, account: WorkerAccount): Promise<PrepareJobResult> {
    const leaseOwner = `prepare-${process.pid}-${randomUUID()}`;
    if (!(await this.jobRepository.claimJob(job.id, leaseOwner))) {
      return { prepared: false, blockedByLogin: false, message: "任务已被其他 Worker 准备。" };
    }
    try {
      const jobStartedAt = Date.now();
      logDebugTiming("worker.prepareQueuedJobs", "job_start", {
        jobId: job.id,
        accountId: job.accountId,
        status: job.status,
        scheduledAt: job.scheduledAt
      });
      const promptContext = await this.ensurePromptSnapshot(job, account);
      const soulContext = await this.ensureSoulSnapshot(job, account);
      const preparedDraft = await this.topicPipelineService.prepareNextPublishableDraft({
        publishJobId: job.id,
        promptSnapshot: promptContext.promptSnapshot,
        accountContext: toAccountPromptContext(account),
        accountSoulMarkdown: soulContext.soulMarkdownSnapshot,
        onStage: async (stage) => {
          logDebugTiming("worker.prepareQueuedJobs", "job_stage", {
            jobId: job.id,
            accountId: job.accountId,
            stage,
            elapsedMs: getElapsedMs(jobStartedAt)
          });
          await this.jobRepository.updateJobStatus(job.id, stage, {
            currentStage: stage,
            promptVersionSnapshotJson: promptContext.promptSnapshotJson,
            failureReason: null,
            lastErrorType: null
          });
        }
      });

      if (!preparedDraft) {
        await this.jobRepository.updateJobStatus(job.id, "queued", {
          currentStage: "queued",
          promptVersionSnapshotJson: promptContext.promptSnapshotJson,
          failureReason: "当前没有可用选题，等待下一轮采题后重试。",
          lastErrorType: null
        });
        logDebugTiming("worker.prepareQueuedJobs", "job_no_candidate", {
          jobId: job.id,
          accountId: job.accountId,
          elapsedMs: getElapsedMs(jobStartedAt)
        });
        return {
          prepared: false,
          blockedByLogin: false,
          message: "当前没有可用选题，等待下一轮采题后重试。"
        };
      }

      if (preparedDraft.kind === "blocked") {
        await this.jobRepository.updateJobStatus(job.id, "needs_manual_review", {
          currentStage: "needs_manual_review",
          promptVersionSnapshotJson: promptContext.promptSnapshotJson,
          failureReason: preparedDraft.reason,
          lastErrorType: "review_block"
        });
        logDebugTiming("worker.prepareQueuedJobs", "job_needs_manual_review", {
          jobId: job.id,
          accountId: job.accountId,
          reason: preparedDraft.reason,
          elapsedMs: getElapsedMs(jobStartedAt)
        });
        return {
          prepared: false,
          blockedByLogin: false,
          message: preparedDraft.reason
        };
      }

      await this.jobRepository.replaceJobPayload(job.id, {
        topicCardId: preparedDraft.topicCardId,
        reviewId: preparedDraft.reviewId,
        title: preparedDraft.title,
        promptVersionSnapshotJson: promptContext.promptSnapshotJson
      });
      logDebugTiming("worker.prepareQueuedJobs", "job_ready", {
        jobId: job.id,
        accountId: job.accountId,
        topicCardId: preparedDraft.topicCardId,
        reviewId: preparedDraft.reviewId,
        elapsedMs: getElapsedMs(jobStartedAt)
      });
      return {
        prepared: true,
        blockedByLogin: false,
        message: null
      };
    } catch (error) {
      if (error instanceof SessionStateError) {
        await this.pauseAccountForLogin(job.accountId, error.message, {
          jobId: job.id,
          slotId: job.scheduleSlotId,
          failureType: mapSessionFailureType(error.sessionState),
          triggerStage: job.currentStage ?? "queued"
        });
        logDebugTiming("worker.prepareQueuedJobs", "job_blocked_by_login", {
          jobId: job.id,
          accountId: job.accountId,
          message: error.message
        });
        return {
          prepared: false,
          blockedByLogin: true,
          message: error.message
        };
      }

      logDebugTiming("worker.prepareQueuedJobs", "job_failed", {
        jobId: job.id,
        accountId: job.accountId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (isLlmConnectionError(error) || isRetryableLockError(error)) {
        const message = error instanceof Error ? error.message : "准备稿件时发生可重试错误。";
        console.error("[worker] retryable error during prepare, will retry next tick", {
          jobId: job.id,
          error: message
        });
        await this.jobRepository.updateJobStatus(job.id, "queued", {
          currentStage: "queued",
          failureReason: isRetryableLockError(error)
            ? "数据库锁冲突，等待下一轮自动重试。"
            : "LLM 连接失败，等待下一轮自动重试。",
          lastErrorType: null
        });
        return {
          prepared: false,
          blockedByLogin: false,
          message
        };
      }

      await this.failJob(
        job.id,
        job.scheduleSlotId,
        "unknown_failure",
        error instanceof Error ? error.message : "准备稿件时发生未知错误。"
      );
      return {
        prepared: false,
        blockedByLogin: false,
        message: error instanceof Error ? error.message : "准备稿件时发生未知错误。"
      };
    } finally {
      await this.jobRepository.releaseJobLease(job.id, leaseOwner);
    }
  }

  private async processDueJobs(
    dueJobs: JobListItem[],
    accountsById: Map<number, WorkerAccount>,
    blockedAccountIds: Set<number>,
    blockedMessages: string[]
  ): Promise<{ processedJobs: number }> {
    const startedAt = Date.now();
    logDebugTiming("worker.processDueJobs", "start", {
      dueJobs: dueJobs.map((job) => ({ id: job.id, accountId: job.accountId, status: job.status, scheduledAt: job.scheduledAt }))
    });
    let processedJobs = 0;

    for (const job of dueJobs) {
      if (blockedAccountIds.has(job.accountId)) {
        continue;
      }

      const account =
        accountsById.get(job.accountId) ??
        (await this.accountRepository.getAccount(job.accountId)) ??
        null;
      if (!account) {
        continue;
      }

      if (!account.profileDir) {
        continue;
      }

      if (isLoginBlockedAccount(account) || isCoolingDown(account)) {
        blockedAccountIds.add(job.accountId);
        blockedMessages.push(resolveAccountBlockMessage(account));
        continue;
      }

      accountsById.set(account.id, account);
      const result = await this.executeJob(job, account);
      processedJobs += 1;
      logDebugTiming("worker.processDueJobs", "job_processed", {
        jobId: job.id,
        accountId: job.accountId,
        blockedByLogin: result.blockedByLogin,
        elapsedMs: getElapsedMs(startedAt)
      });

      if (result.blockedByLogin) {
        blockedAccountIds.add(job.accountId);
        blockedMessages.push(result.message ?? `账号 #${job.accountId} 需要人工登录恢复。`);
        accountsById.set(job.accountId, {
          ...account,
          status: "manual_login_required",
          statusReason: result.message
        });
      }
    }

    logDebugTiming("worker.processDueJobs", "done", {
      processedJobs,
      elapsedMs: getElapsedMs(startedAt)
    });

    return { processedJobs };
  }

  private async executeJob(job: JobListItem, account: WorkerAccount): Promise<TickBranchResult> {
    let jobDetail = await this.jobRepository.getJobById(job.id);
    const slot = await this.scheduleRepository.getSlotByJobId(job.id);
    const profileDir = account.profileDir;

    if (!profileDir) {
      return { blockedByLogin: false, message: null };
    }

    if (!jobDetail) {
      await this.failJob(job.id, slot?.id ?? null, "network_or_page_error", "任务缺少完整的题目信息。");
      return { blockedByLogin: false, message: null };
    }

    const promptContext = await this.ensurePromptSnapshot(jobDetail, account);
    const soulContext = await this.ensureSoulSnapshot(jobDetail, account);
    if (!jobDetail.questionUrl || !jobDetail.questionTitle || !resolveJobContent(jobDetail)) {
      const repairedJobDetail = await this.tryRehydrateJobPayload(
        job.id,
        account,
        promptContext,
        soulContext.soulMarkdownSnapshot
      );
      if (repairedJobDetail) {
        jobDetail = repairedJobDetail;
      }
    }

    if (!jobDetail.questionUrl || !jobDetail.questionTitle) {
      if (!jobDetail.topicCardId || !jobDetail.reviewId) {
        await this.requeueJobForPreparation(
          job.id,
          slot?.id ?? null,
          promptContext.promptSnapshotJson,
          "任务缺少完整的题目信息，已转回待准备队列等待自动补齐。"
        );
        return { blockedByLogin: false, message: null };
      }

      await this.failJob(job.id, slot?.id ?? null, "network_or_page_error", "任务缺少完整的题目信息。");
      return { blockedByLogin: false, message: null };
    }

    let questionTitle = jobDetail.questionTitle;
    let questionUrl = jobDetail.questionUrl;
    let content = resolveJobContent(jobDetail);
    const accountSoulMarkdown = soulContext.soulMarkdownSnapshot;
    if (!content) {
      if (!jobDetail.topicCardId || !jobDetail.reviewId) {
        await this.requeueJobForPreparation(
          job.id,
          slot?.id ?? null,
          promptContext.promptSnapshotJson,
          "任务缺少完整的正文载荷，已转回待准备队列等待自动补齐。"
        );
        return { blockedByLogin: false, message: null };
      }

      await this.failJob(job.id, slot?.id ?? null, "content_risk_block", "没有可发布的正文内容。", jobDetail.topicCardId);
      return { blockedByLogin: false, message: null };
    }

    let promptSnapshot = promptContext.promptSnapshot;
    let retryCount = job.retryCount;
    let rewriteCount = 0;
    const sessionKey = `publish-account-${job.accountId}-job-${job.id}`;
    const baseTraceGroupId = `job-${job.id}-${Date.now()}`;
    let keepBrowserOpenForChallenge = false;
    const leaseOwner = `worker-${process.pid}-${randomUUID()}`;
    const claimed = await this.jobRepository.claimJob(job.id, leaseOwner);
    if (!claimed) {
      console.warn("[worker] skipped job because another worker owns its lease", { jobId: job.id, accountId: job.accountId });
      return { blockedByLogin: false, message: "任务已被其他 Worker 领取。" };
    }

    await this.jobRepository.updateJobStatus(job.id, "publishing", {
      currentStage: "login_checking",
      resumeAnchorJson: jobDetail.resumeAnchorJson,
      promptVersionSnapshotJson: promptContext.promptSnapshotJson,
      failureReason: null
    });

    if (slot) {
      await this.scheduleRepository.updateSlotStatus(slot.id, "in_progress");
    }

    try {
      while (true) {
      const attemptNo = retryCount + 1;
      const traceGroupId = `${baseTraceGroupId}-attempt-${attemptNo}`;
      const attemptPayload = {
        questionUrl,
        traceGroupId,
        startedAt: new Date().toISOString()
      };

      await this.jobRepository.cleanupRunningAttemptsForJob(job.id, {
        reason: `Superseded by publish attempt #${attemptNo}.`
      });

      const attemptId = await this.jobRepository.createPublishAttempt(
        job.id,
        attemptNo,
        "running",
        questionUrl,
        attemptPayload
      );

      logExecutionContext({
        jobId: job.id,
        accountId: job.accountId,
        stage: "publishing",
        traceId: traceGroupId,
        attemptNo
      });

      try {
        const publishResult = await withTimeoutReject(
          this.publishService.runPublishAttempt({
            sessionKey,
            traceGroupId,
            profileDir,
            questionUrl,
            content,
            publishJobId: job.id,
            publishAttemptId: attemptId,
            promptSnapshot,
            resumeAnchor: safeParseJson<PublishResumeAnchor | null>(jobDetail.resumeAnchorJson ?? "", null),
            expectedZhihuUserName: account.zhihuUserName,
            accountName: account.name
          }),
          PUBLISH_ATTEMPT_TIMEOUT_MS,
          `发布步骤超时（>${Math.round(PUBLISH_ATTEMPT_TIMEOUT_MS / 1000)}s），已中断并重试。`,
          async () => {
            await this.publishService.closeSession(sessionKey);
          }
        );

        await this.finalizePublishedJob({
          job,
          jobDetail,
          slotId: slot?.id ?? null,
          attemptId,
          finalUrl: publishResult.finalUrl,
          screenshotPath: publishResult.screenshotPath,
          promptSnapshotJson: promptContext.promptSnapshotJson,
          attemptPayload: {
            ...attemptPayload,
            finishedAt: new Date().toISOString(),
            pageSnapshot: publishResult.pageSnapshot
          },
          publishStage: "publish_verify",
          artifactPhase: "publish-success"
        });

        await this.publishService.closeSession(sessionKey);
        return { blockedByLogin: false, message: null };
      } catch (error) {
        const failure = normalizePublishError(error);

        await this.jobRepository.updatePublishAttempt(attemptId, {
          status: "failed",
          currentUrl: failure.currentUrl,
          payload: {
            ...attemptPayload,
            finishedAt: new Date().toISOString(),
            meta: failure.meta
          },
          failureType: failure.failureType,
          failureReason: failure.message
        });

        const screenshotPath = typeof failure.meta.screenshotPath === "string" ? failure.meta.screenshotPath : null;
        if (screenshotPath) {
          await this.jobRepository.createArtifact(attemptId, "screenshot", screenshotPath, {
            phase: "publish-failure"
          });
        }

        const recoveredAsPublished = await this.tryFinalizePublishedFromExistingResult({
          job,
          jobDetail,
          slotId: slot?.id ?? null,
          attemptId,
          attemptPayload,
          failure,
          sessionKey,
          profileDir,
          content,
          promptSnapshot,
          promptSnapshotJson: promptContext.promptSnapshotJson,
          traceGroupId,
          expectedZhihuUserName: account.zhihuUserName,
          accountName: account.name
        });
        if (recoveredAsPublished) {
          await this.publishService.closeSession(sessionKey);
          return { blockedByLogin: false, message: null };
        }

        const resolution = await this.failureResolutionService.resolve(
          {
            failureType: failure.failureType,
            retryCount,
            context: {
              jobId: job.id,
              slotId: slot?.id ?? null,
              meta: failure.meta
            }
          },
          promptSnapshot
        );

        const resumeAnchorJson = JSON.stringify(
          normalizeResumeAnchor(failure.meta.resumeAnchor, failure.currentUrl ?? questionUrl)
        );

        if (resolution.action === "MANUAL_LOGIN") {
          const keepChallengePageOpen = shouldKeepChallengePageOpenForManualRecovery(failure);
          const recoveryMessage = buildManualRecoveryMessage(failure.message, keepChallengePageOpen);

          await this.pauseAccountForLogin(job.accountId, recoveryMessage, {
            jobId: job.id,
            slotId: slot?.id ?? null,
            resumeAnchorJson,
            failureType: keepChallengePageOpen ? "challenge_required" : failure.failureType
          });
          if (keepChallengePageOpen) {
            keepBrowserOpenForChallenge = true;
            this.publishService.scheduleSessionClose(sessionKey, CHALLENGE_PAGE_KEEP_OPEN_MS);
          }

          return {
            blockedByLogin: true,
            message: recoveryMessage
          };
        }

        if (resolution.action === "VERIFY_ONCE") {
          const verifyResult = await this.publishService.verifyExistingResult({
            sessionKey,
            traceGroupId: `${traceGroupId}-verify`,
            profileDir,
            publishJobId: job.id,
            publishAttemptId: attemptId,
            currentUrl: failure.currentUrl ?? questionUrl,
            content,
            promptSnapshot,
            expectedZhihuUserName: account.zhihuUserName,
            accountName: account.name
          });

          if (verifyResult.ok) {
            await this.finalizePublishedJob({
              job,
              jobDetail,
              slotId: slot?.id ?? null,
              attemptId,
              finalUrl: verifyResult.finalUrl,
              screenshotPath: verifyResult.screenshotPath,
              promptSnapshotJson: promptContext.promptSnapshotJson,
              attemptPayload: {
                verifyResult,
                finishedAt: new Date().toISOString()
              },
              publishStage: "publish_verify",
              artifactPhase: "publish-verify"
            });

            await this.publishService.closeSession(sessionKey);
            return { blockedByLogin: false, message: null };
          }
        }

        if (resolution.action === "REWRITE_ONCE") {
          if (rewriteCount >= 1 || !jobDetail.topicCardId) {
            await this.failJob(
              job.id,
              slot?.id ?? null,
              failure.failureType,
              `${failure.message}；内容重写次数已用尽。`,
              jobDetail.topicCardId
            );
            await this.publishService.closeSession(sessionKey);
            return { blockedByLogin: false, message: null };
          }

          const rewritten = await this.topicPipelineService.rewriteExistingTopic({
            publishJobId: job.id,
            topicCardId: jobDetail.topicCardId,
            candidateTitle: questionTitle,
            questionUrl,
            revisionFeedback: `${failure.message}；${resolution.reason}`,
            promptVersionSnapshotJson: promptContext.promptSnapshotJson,
            accountContext: toAccountPromptContext(account),
            accountSoulMarkdown,
            onStage: async (stage) => {
              await this.jobRepository.updateJobStatus(job.id, stage, {
                currentStage: stage,
                promptVersionSnapshotJson: promptContext.promptSnapshotJson,
                failureReason: null,
                lastErrorType: null
              });
            }
          });

          if (rewritten?.kind === "ready") {
            await this.jobRepository.replaceJobPayload(job.id, {
              topicCardId: jobDetail.topicCardId,
              reviewId: rewritten.reviewId,
              title: rewritten.title,
              promptVersionSnapshotJson: promptContext.promptSnapshotJson
            });

            jobDetail = await this.jobRepository.getJobById(job.id);
            content = jobDetail?.approvedContent ?? jobDetail?.humanizedContent ?? jobDetail?.draftContent ?? null;
            if (!jobDetail || !content) {
              await this.failJob(job.id, slot?.id ?? null, "content_risk_block", "重写后没有得到可发布内容。", jobDetail?.topicCardId);
              await this.publishService.closeSession(sessionKey);
              return { blockedByLogin: false, message: null };
            }
            if (jobDetail.questionTitle && jobDetail.questionUrl) {
              questionTitle = jobDetail.questionTitle;
              questionUrl = jobDetail.questionUrl;
            }

            promptSnapshot = safeParseJson<PromptSnapshotMap>(jobDetail.promptVersionSnapshotJson ?? "{}", {});
            rewriteCount += 1;
            retryCount = 0;
            await this.publishService.restartSession({
              sessionKey,
              profileDir,
              traceGroupId: `${traceGroupId}-rewrite`
            });
            continue;
          }

          if (rewritten?.kind === "duplicate") {
            const replacementSucceeded = await this.reselectTopicForJob(
              job.id,
              jobDetail.topicCardId ?? null,
              slot?.id ?? null,
              promptContext.promptSnapshotJson,
              rewritten.reason,
              toAccountPromptContext(account),
              accountSoulMarkdown
            );
            if (!replacementSucceeded) {
              await this.failJob(job.id, slot?.id ?? null, "duplicate_block", rewritten.reason, jobDetail.topicCardId);
              await this.publishService.closeSession(sessionKey);
              return { blockedByLogin: false, message: null };
            }

            jobDetail = await this.jobRepository.getJobById(job.id);
            content = jobDetail?.approvedContent ?? jobDetail?.humanizedContent ?? jobDetail?.draftContent ?? null;
            if (!jobDetail || !content) {
              await this.failJob(job.id, slot?.id ?? null, "duplicate_block", "换题后没有得到可发布内容。", jobDetail?.topicCardId);
              await this.publishService.closeSession(sessionKey);
              return { blockedByLogin: false, message: null };
            }
            if (jobDetail.questionTitle && jobDetail.questionUrl) {
              questionTitle = jobDetail.questionTitle;
              questionUrl = jobDetail.questionUrl;
            }

            promptSnapshot = safeParseJson<PromptSnapshotMap>(jobDetail.promptVersionSnapshotJson ?? "{}", {});
            retryCount = 0;
            await this.publishService.restartSession({
              sessionKey,
              profileDir,
              traceGroupId: `${traceGroupId}-reselect`
            });
            continue;
          }

          await this.failJob(
            job.id,
            slot?.id ?? null,
            failure.failureType,
            rewritten?.reason ?? resolution.reason,
            jobDetail.topicCardId
          );
          await this.publishService.closeSession(sessionKey);
          return { blockedByLogin: false, message: null };
        }

        if (resolution.action === "RESELECT_TOPIC") {
          const replacementSucceeded = await this.reselectTopicForJob(
            job.id,
            jobDetail.topicCardId ?? null,
            slot?.id ?? null,
            promptContext.promptSnapshotJson,
            failure.message,
            toAccountPromptContext(account),
            accountSoulMarkdown
          );
          if (!replacementSucceeded) {
            await this.failJob(job.id, slot?.id ?? null, "duplicate_block", failure.message, jobDetail.topicCardId);
            await this.publishService.closeSession(sessionKey);
            return { blockedByLogin: false, message: null };
          }

          jobDetail = await this.jobRepository.getJobById(job.id);
          content = jobDetail?.approvedContent ?? jobDetail?.humanizedContent ?? jobDetail?.draftContent ?? null;
          if (!jobDetail || !content) {
            await this.failJob(job.id, slot?.id ?? null, "duplicate_block", "换题后没有得到可发布内容。", jobDetail?.topicCardId);
            await this.publishService.closeSession(sessionKey);
            return { blockedByLogin: false, message: null };
          }
          if (jobDetail.questionTitle && jobDetail.questionUrl) {
            questionTitle = jobDetail.questionTitle;
            questionUrl = jobDetail.questionUrl;
          }

          promptSnapshot = safeParseJson<PromptSnapshotMap>(jobDetail.promptVersionSnapshotJson ?? "{}", {});
          retryCount = 0;
          await this.publishService.restartSession({
            sessionKey,
            profileDir,
            traceGroupId: `${traceGroupId}-reselect`
          });
          continue;
        }

        if (
          resolution.action === "RETRY_SAME_SESSION" ||
          resolution.action === "RESTART_BROWSER" ||
          resolution.action === "VERIFY_ONCE"
        ) {
          if (retryCount >= 2) {
            await this.failJob(
              job.id,
              slot?.id ?? null,
              failure.failureType,
              `${failure.message}；浏览器重试次数已用尽。`,
              jobDetail.topicCardId
            );
            await this.publishService.closeSession(sessionKey);
            return { blockedByLogin: false, message: null };
          }

          retryCount += 1;
          await this.jobRepository.incrementRetry(job.id);
          await this.jobRepository.updateJobStatus(job.id, "retry_waiting", {
            failureReason: `${failure.message}；${resolution.reason}`,
            currentStage: "retry_waiting",
            resumeAnchorJson,
            lastErrorType: failure.failureType,
            promptVersionSnapshotJson: promptContext.promptSnapshotJson
          });

          // Adaptive backoff: wait before retrying to avoid hammering
          const backoffMs = calculateRetryBackoff(retryCount, failure.failureType);
          if (backoffMs > 0) {
            logExecutionContext({
              jobId: job.id,
              accountId: job.accountId,
              stage: "retry_backoff",
              traceId: traceGroupId,
              attemptNo
            });
            console.log(`[Worker] Retry #${retryCount} backoff for ${Math.round(backoffMs / 1000)}s (failureType: ${failure.failureType})`);
            await wait(backoffMs);
          }

          if (resolution.action === "RESTART_BROWSER") {
            await this.publishService.restartSession({
              sessionKey,
              profileDir,
              traceGroupId: `${traceGroupId}-restart`
            });
          }
          continue;
        }

        await this.failJob(
          job.id,
          slot?.id ?? null,
          failure.failureType,
          `${failure.message}；${resolution.reason}`,
          jobDetail.topicCardId
        );
        await this.publishService.closeSession(sessionKey);
        return { blockedByLogin: false, message: null };
      }
    }
    } finally {
      if (!keepBrowserOpenForChallenge) {
        await this.publishService.closeSession(sessionKey);
      }
      await this.jobRepository.releaseJobLease(job.id, leaseOwner);
    }
  }

  private async reselectTopicForJob(
    jobId: number,
    currentTopicCardId: number | null,
    slotId: number | null,
    promptSnapshotJson: string,
    reason: string,
    accountContext?: AccountPromptContext | null,
    accountSoulMarkdown?: string | null
  ) {
    if (currentTopicCardId) {
      await this.topicRepository.markCandidateDuplicateByTopicCard(currentTopicCardId, reason);
    }

    const promptSnapshot = safeParseJson<PromptSnapshotMap>(promptSnapshotJson, {});
    const replacement = await this.topicPipelineService.prepareNextPublishableDraft({
      publishJobId: jobId,
      promptSnapshot,
      accountContext,
      accountSoulMarkdown,
      onStage: async (stage) => {
        await this.jobRepository.updateJobStatus(jobId, stage, {
          currentStage: stage,
          promptVersionSnapshotJson: promptSnapshotJson,
          failureReason: null,
          lastErrorType: null
        });
      }
    });

    if (!replacement) {
      return false;
    }

    if (replacement.kind === "blocked") {
      await this.jobRepository.updateJobStatus(jobId, "needs_manual_review", {
        currentStage: "needs_manual_review",
        promptVersionSnapshotJson: promptSnapshotJson,
        failureReason: replacement.reason,
        lastErrorType: "review_block"
      });
      return false;
    }

    await this.jobRepository.replaceJobPayload(jobId, {
      topicCardId: replacement.topicCardId,
      reviewId: replacement.reviewId,
      title: replacement.title,
      promptVersionSnapshotJson: promptSnapshotJson
    });

    if (slotId) {
      await this.scheduleRepository.updateSlotStatus(slotId, "in_progress");
    }

    return true;
  }

  private async requeueJobForPreparation(
    jobId: number,
    slotId: number | null,
    promptVersionSnapshotJson: string,
    message: string
  ) {
    await this.jobRepository.retryJob(jobId);
    await this.jobRepository.updateJobStatus(jobId, "queued", {
      currentStage: "queued",
      promptVersionSnapshotJson,
      failureReason: message,
      resumeAnchorJson: null,
      lastErrorType: null
    });

    if (slotId) {
      await this.scheduleRepository.updateSlotStatus(slotId, "pending");
    }
  }

  private async failJob(
    jobId: number,
    slotId: number | null,
    failureType: FailureType,
    message: string,
    topicCardId?: number | null
  ) {
    const jobDetail = await this.jobRepository.getJobById(jobId);
    const account = jobDetail ? await this.accountRepository.getAccount(jobDetail.accountId) : null;
    const triggerStage = resolveNotificationTriggerStage({
      resumeAnchorJson: jobDetail?.resumeAnchorJson ?? null,
      preferredStage: jobDetail?.currentStage ?? null,
      fallbackStage: "failed_terminal"
    });
    const entryUrl = resolveNotificationEntryUrl({
      resumeAnchorJson: jobDetail?.resumeAnchorJson ?? null,
      questionUrl: jobDetail?.questionUrl ?? null,
      finalUrl: jobDetail?.finalUrl ?? null
    });

    await this.jobRepository.cleanupRunningAttemptsForJob(jobId, {
      reason: `Closed stale running attempts after job #${jobId} entered failed_terminal.`
    });

    await this.jobRepository.updateJobStatus(jobId, "failed_terminal", {
      failureReason: `${failureType}: ${message}`,
      currentStage: "failed_terminal",
      lastErrorType: failureType
    });

    if (topicCardId) {
      if (failureType === "network_or_page_error" || failureType === "topic_invalid") {
        await this.topicRepository.markCandidateValidityByTopicCard(
          topicCardId,
          "invalid",
          `${failureType}: ${message}`
        );
      }

      if (failureType === "duplicate_block") {
        await this.topicRepository.markCandidateDuplicateByTopicCard(topicCardId, `${failureType}: ${message}`);
      } else {
        await this.topicRepository.markCandidatePublishFailedByTopicCard(topicCardId, `${failureType}: ${message}`);
      }
    }

    if (slotId) {
      await this.scheduleRepository.updateSlotStatus(slotId, "failed");
    }

    await this.reportOpsProblem(
      {
        source: "worker_job",
        severity: mapFailureSeverity(failureType),
        serviceName: "zhihu-worker",
        accountId: account?.id ?? jobDetail?.accountId ?? null,
        jobId,
        failureType,
        title: `Publish job #${jobId} failed`,
        currentStage: "failed_terminal",
        triggerStage,
        entryUrl,
        questionTitle: jobDetail?.questionTitle ?? jobDetail?.title ?? null,
        rawErrorExcerpt: message,
        evidence: {
          topicCardId: topicCardId ?? null
        }
      },
      {
        accountName: account?.name ?? (jobDetail ? `账号#${jobDetail.accountId}` : `账号任务#${jobId}`),
        zhihuUserName: account?.zhihuUserName ?? null,
        jobId,
        currentStage: "failed_terminal",
        triggerStage,
        failureType,
        failureReason: message,
        questionTitle: jobDetail?.questionTitle ?? jobDetail?.title ?? null,
        entryUrl,
        note: buildFailureDiagnosticNote(message)
      }
    );
  }

  private async tryFinalizePublishedFromExistingResult(input: {
    job: JobListItem;
    jobDetail: JobDetail;
    slotId: number | null;
    attemptId: number;
    attemptPayload: Record<string, unknown>;
    failure: {
      failureType: FailureType;
      message: string;
      currentUrl: string | null;
      meta: Record<string, unknown>;
    };
    sessionKey: string;
    profileDir: string;
    content: string;
    promptSnapshot: PromptSnapshotMap;
    promptSnapshotJson: string;
    traceGroupId: string;
    expectedZhihuUserName: string | null;
    accountName: string;
  }) {
    const verificationUrl = pickVerificationUrl(input.jobDetail, input.failure);
    if (!verificationUrl) {
      return false;
    }

    try {
      const verifyResult = await this.publishService.verifyExistingResult({
        sessionKey: input.sessionKey,
        traceGroupId: `${input.traceGroupId}-recover`,
        profileDir: input.profileDir,
        publishJobId: input.job.id,
        publishAttemptId: input.attemptId,
        currentUrl: verificationUrl,
        content: input.content,
        promptSnapshot: input.promptSnapshot,
        expectedZhihuUserName: input.expectedZhihuUserName,
        accountName: input.accountName
      });

      if (!verifyResult.ok) {
        return false;
      }

      await this.finalizePublishedJob({
        job: input.job,
        jobDetail: input.jobDetail,
        slotId: input.slotId,
        attemptId: input.attemptId,
        finalUrl: verifyResult.finalUrl,
        screenshotPath: verifyResult.screenshotPath,
        promptSnapshotJson: input.promptSnapshotJson,
        attemptPayload: {
          ...input.attemptPayload,
          recoveredFromFailureType: input.failure.failureType,
          recoveredFromUrl: verificationUrl,
          finishedAt: new Date().toISOString(),
          verifyResult
        },
        publishStage: "publish_verify",
        artifactPhase: "publish-verify"
      });

      return true;
    } catch {
      return false;
    }
  }

  private async finalizePublishedJob(input: {
    job: JobListItem;
    jobDetail: JobDetail;
    slotId: number | null;
    attemptId: number;
    finalUrl: string;
    screenshotPath?: string | null;
    promptSnapshotJson: string;
    attemptPayload: Record<string, unknown>;
    publishStage?: string | null;
    artifactPhase?: string;
  }) {
    await this.jobRepository.updatePublishAttempt(input.attemptId, {
      status: "published",
      currentUrl: input.finalUrl,
      payload: input.attemptPayload,
      failureType: null,
      failureReason: null
    });

    await this.jobRepository.cleanupRunningAttemptsForJob(input.job.id, {
      exceptAttemptId: input.attemptId,
      reason: `Closed stale running attempts after publish attempt #${input.attemptId} succeeded.`
    });

    if (input.screenshotPath) {
      await this.jobRepository.createArtifact(input.attemptId, "screenshot", input.screenshotPath, {
        phase: input.artifactPhase ?? "publish-verify"
      });
    }

    await this.jobRepository.updateJobStatus(input.job.id, "published", {
      finalUrl: input.finalUrl,
      failureReason: null,
      currentStage: "published",
      resumeAnchorJson: null,
      lastErrorType: null,
      promptVersionSnapshotJson: input.promptSnapshotJson
    });

    if (input.slotId) {
      await this.scheduleRepository.updateSlotStatus(input.slotId, "published");
    }

    if (input.jobDetail.topicCardId) {
      await this.topicRepository.markCandidatePublishedByTopicCard(input.jobDetail.topicCardId);
    }

    if (input.jobDetail.questionUrl && input.jobDetail.questionTitle) {
      try {
        await this.topicRepository.upsertAnsweredTopic({
          accountId: input.job.accountId,
          questionUrl: input.jobDetail.questionUrl,
          questionTitle: input.jobDetail.questionTitle,
          topicCardId: input.jobDetail.topicCardId,
          reviewId: input.jobDetail.reviewId,
          publishJobId: input.job.id,
          answerUrl: input.finalUrl,
          answeredAt: new Date()
        });
      } catch (error) {
        console.error("[worker] failed to persist answered topic history", error);
      }
    }

    await this.accountRepository.touchPublishSuccess(input.job.accountId);

    const account = await this.accountRepository.getAccount(input.job.accountId);
    await this.feishuNotificationService.sendPublishSuccessNotification({
      accountName: account?.name ?? `账号#${input.job.accountId}`,
      zhihuUserName: account?.zhihuUserName ?? null,
      jobId: input.job.id,
      publishStage: input.publishStage ?? "publish_verify",
      questionTitle: input.jobDetail.questionTitle ?? input.jobDetail.title ?? input.job.title,
      publishedAt: new Date(),
      scheduledAt: input.jobDetail.scheduledAt ?? input.job.scheduledAt,
      finalUrl: input.finalUrl
    });
  }

  private async pauseAccountForLogin(
    accountId: number,
    reason: string,
    options?: {
      jobId?: number | null;
      slotId?: number | null;
      resumeAnchorJson?: string | null;
      failureType?: FailureType;
      triggerStage?: string | null;
    }
  ) {
    const account = await this.accountRepository.getAccount(accountId);
    const targetJob = options?.jobId != null ? await this.jobRepository.getJobById(options.jobId) : null;
    const cooldownHours = resolveRiskCooldownHours(options?.failureType);
    const triggerStage = resolveNotificationTriggerStage({
      resumeAnchorJson: options?.resumeAnchorJson ?? targetJob?.resumeAnchorJson ?? null,
      preferredStage: options?.triggerStage ?? targetJob?.currentStage ?? null,
      fallbackStage: "manual_login_required"
    });
    const entryUrl = resolveNotificationEntryUrl({
      resumeAnchorJson: options?.resumeAnchorJson ?? targetJob?.resumeAnchorJson ?? null,
      questionUrl: targetJob?.questionUrl ?? null,
      finalUrl: targetJob?.finalUrl ?? null
    });

    await this.accountRepository.markRiskDetected(accountId, {
      cooldownHours
    });
    await this.accountRepository.markManualLoginRequired(accountId, reason);

    const dueJobs = (await this.jobRepository.getDueJobs()).filter((job) => job.accountId === accountId);
    const targetIds = new Set<number>(dueJobs.map((job) => job.id));
    if (options?.jobId) {
      targetIds.add(options.jobId);
    }

    for (const jobId of targetIds) {
      await this.jobRepository.cleanupRunningAttemptsForJob(jobId, {
        reason: `Closed stale running attempts after account #${accountId} entered manual_login_required.`
      });

      const slot =
        options?.jobId === jobId && options.slotId
          ? { id: options.slotId }
          : await this.scheduleRepository.getSlotByJobId(jobId);

      await this.jobRepository.updateJobStatus(jobId, "manual_login_required", {
        failureReason: reason,
        currentStage: "manual_login_required",
        resumeAnchorJson: options?.jobId === jobId ? options.resumeAnchorJson ?? null : null,
        lastErrorType: options?.jobId === jobId ? options.failureType ?? "login_required" : "login_required"
      });

      if (slot) {
        await this.scheduleRepository.updateSlotStatus(slot.id, "manual_login_required");
      }
    }

    await this.reportOpsProblem(
      {
        source: "manual_login",
        severity: "high",
        serviceName: "zhihu-worker",
        accountId,
        jobId: targetJob?.id ?? options?.jobId ?? null,
        failureType: options?.failureType ?? "login_required",
        title: `Account #${accountId} requires manual login`,
        currentStage: "manual_login_required",
        triggerStage,
        entryUrl,
        questionTitle: targetJob?.questionTitle ?? targetJob?.title ?? null,
        rawErrorExcerpt: reason,
        evidence: {
          note: targetJob ? null : "Account-level block without a linked publish job."
        }
      },
      {
        accountName: account?.name ?? `账号#${accountId}`,
        zhihuUserName: account?.zhihuUserName ?? null,
        jobId: targetJob?.id ?? options?.jobId ?? null,
        currentStage: "manual_login_required",
        triggerStage,
        failureType: options?.failureType ?? "login_required",
        failureReason: reason,
        questionTitle: targetJob?.questionTitle ?? targetJob?.title ?? null,
        entryUrl,
        note: targetJob ? null : "当前为账号级阻塞，无关联发布任务。"
      }
    );
  }

  private async reportOpsProblem(
    incidentInput: Parameters<OpsIncidentService["reportIncident"]>[0],
    fallbackInput: Parameters<FeishuNotificationService["sendProblemNotification"]>[0]
  ) {
    if (this.opsIncidentService) {
      try {
        await this.opsIncidentService.reportIncident(incidentInput);
        return;
      } catch (error) {
        console.error("[worker] failed to report ops incident", error);
      }
    }

    await this.feishuNotificationService.sendProblemNotification(fallbackInput);
  }

  private async ensureAccountSoulDocument(account: WorkerAccount) {
    const inheritFromAccountId = readWriterPromptSourceAccountId(account);
    const ensureSoul = this.accountSoulService.ensureSoulDocument.bind(this.accountSoulService) as (
      account: WorkerAccount,
      inheritFromAccountId?: number | null
    ) => ReturnType<AccountSoulService["ensureSoulDocument"]>;
    return ensureSoul(account, inheritFromAccountId);
  }

  private async resolveWriterPromptVersionId(account?: Pick<WorkerAccount, "id" | "writerPromptVersionId"> | null) {
    if (!account) {
      return null;
    }
    const repository = this.accountRepository as AccountRepository & {
      resolveEffectiveWriterPromptVersionId?: (accountId: number) => Promise<number | null>;
    };
    if (typeof repository.resolveEffectiveWriterPromptVersionId === "function") {
      return repository.resolveEffectiveWriterPromptVersionId(account.id);
    }
    return account.writerPromptVersionId ?? null;
  }

  private async ensurePromptSnapshot(
    job: Pick<JobListItem, "id" | "status" | "currentStage" | "promptVersionSnapshotJson">,
    account?: Pick<WorkerAccount, "id" | "writerPromptVersionId"> | null
  ) {
    if (job.promptVersionSnapshotJson) {
      return {
        promptSnapshotJson: job.promptVersionSnapshotJson,
        promptSnapshot: safeParseJson<PromptSnapshotMap>(job.promptVersionSnapshotJson, {})
      };
    }

    const promptSnapshot = await this.llmService.getPromptSnapshotForAccount({
      writerPromptVersionId: await this.resolveWriterPromptVersionId(account)
    });
    const promptSnapshotJson = JSON.stringify(promptSnapshot);

    await this.jobRepository.updateJobStatus(job.id, job.status, {
      currentStage: job.currentStage ?? job.status,
      promptVersionSnapshotJson: promptSnapshotJson
    });

    return {
      promptSnapshotJson,
      promptSnapshot
    };
  }

  private async ensureSoulSnapshot(
    job: Pick<JobListItem, "id" | "status" | "currentStage" | "soulVersion" | "soulMarkdownSnapshot">,
    account: WorkerAccount
  ) {
    if (job.soulMarkdownSnapshot) {
      return {
        soulVersion: job.soulVersion ?? null,
        soulMarkdownSnapshot: job.soulMarkdownSnapshot
      };
    }

    const soulDocument = await this.ensureAccountSoulDocument(account);
    await this.jobRepository.updateJobStatus(job.id, job.status, {
      currentStage: job.currentStage ?? job.status,
      soulVersion: soulDocument.version,
      soulMarkdownSnapshot: soulDocument.markdown
    });

    return {
      soulVersion: soulDocument.version,
      soulMarkdownSnapshot: soulDocument.markdown
    };
  }

  private async tryRehydrateJobPayload(
    jobId: number,
    account: WorkerAccount,
    promptContext: { promptSnapshotJson: string; promptSnapshot: PromptSnapshotMap },
    accountSoulMarkdown?: string | null
  ) {
    const replacement = await this.topicPipelineService.prepareNextPublishableDraft({
      publishJobId: jobId,
      promptSnapshot: promptContext.promptSnapshot,
      accountContext: toAccountPromptContext(account),
      accountSoulMarkdown,
      onStage: async (stage) => {
        await this.jobRepository.updateJobStatus(jobId, stage, {
          currentStage: stage,
          promptVersionSnapshotJson: promptContext.promptSnapshotJson,
          failureReason: null,
          lastErrorType: null
        });
      }
    });

    if (!replacement) {
      return null;
    }

    if (replacement.kind === "blocked") {
      await this.jobRepository.updateJobStatus(jobId, "needs_manual_review", {
        currentStage: "needs_manual_review",
        promptVersionSnapshotJson: promptContext.promptSnapshotJson,
        failureReason: replacement.reason,
        lastErrorType: "review_block"
      });
      return null;
    }

    await this.jobRepository.replaceJobPayload(jobId, {
      topicCardId: replacement.topicCardId,
      reviewId: replacement.reviewId,
      title: replacement.title,
      promptVersionSnapshotJson: promptContext.promptSnapshotJson
    });

    return this.jobRepository.getJobById(jobId);
  }
}

function resolveJobContent(jobDetail: Pick<JobDetail, "approvedContent" | "humanizedContent" | "draftContent">) {
  return jobDetail.approvedContent ?? jobDetail.humanizedContent ?? jobDetail.draftContent;
}

function normalizePublishError(error: unknown) {
  if (error instanceof PublishFlowError) {
    const normalizedFailureType = normalizeFailureTypeByMessage(error.failureType, error.message);
    return {
      failureType: normalizedFailureType,
      message: error.message,
      currentUrl: error.currentUrl,
      meta: error.meta
    };
  }

  if (isLlmConnectionError(error)) {
    return {
      failureType: "llm_connection_error" as FailureType,
      message: error instanceof Error ? error.message : "LLM 连接失败。",
      currentUrl: null,
      meta: {}
    };
  }
  return {
    failureType: normalizeFailureTypeByMessage(
      "network_or_page_error" as FailureType,
      error instanceof Error ? error.message : "发布流程发生未知错误。"
    ),
    message: error instanceof Error ? error.message : "发布流程发生未知错误。",
    currentUrl: null,
    meta: {}
  };
}

function normalizeFailureTypeByMessage(failureType: FailureType, message: string): FailureType {
  if (isChallengeSignalText(message)) {
    return "challenge_required";
  }

  if (failureType !== "network_or_page_error" && failureType !== "unknown_failure") {
    return failureType;
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("尚未登录") ||
    normalized.includes("需要人工登录") ||
    normalized.includes("login required") ||
    normalized.includes("not logged in")
  ) {
    return "login_required";
  }

  if (normalized.includes("账号不一致") || normalized.includes("identity mismatch")) {
    return "account_identity_mismatch";
  }

  if (normalized.includes("session expired") || normalized.includes("登录态失效")) {
    return "session_expired";
  }

  return failureType;
}

function shouldKeepChallengePageOpenForManualRecovery(input: {
  failureType: FailureType;
  message: string;
  currentUrl: string | null;
  meta: Record<string, unknown>;
}) {
  if (input.failureType === "challenge_required") {
    return true;
  }

  const metaSnapshotUrl =
    typeof input.meta.snapshot === "object" &&
    input.meta.snapshot &&
    "url" in input.meta.snapshot &&
    typeof (input.meta.snapshot as { url?: unknown }).url === "string"
      ? ((input.meta.snapshot as { url: string }).url)
      : null;

  return isChallengeSignalText([input.message, input.currentUrl, metaSnapshotUrl].filter(Boolean).join(" "));
}

function buildManualRecoveryMessage(message: string, keepChallengePageOpen: boolean) {
  if (!keepChallengePageOpen) {
    return message;
  }

  if (message.includes("当前发布页已保留")) {
    return message;
  }

  return `${message} 当前发布页已保留最多 15 分钟。请直接在这个浏览器页面里完成人机验证、滑块或其他反爬挑战，处理完后再点“登录成功，继续下一步”。超时后浏览器会强制关闭，避免占用内存。`;
}

function isChallengeSignalText(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("account/unhuman") ||
    normalized.includes("captcha") ||
    normalized.includes("challenge") ||
    normalized.includes("安全验证") ||
    normalized.includes("异常验证") ||
    normalized.includes("人机验证") ||
    normalized.includes("滑块") ||
    normalized.includes("风控") ||
    normalized.includes("反爬") ||
    normalized.includes("风险验证") ||
    normalized.includes("访问受限")
  );
}

function isLlmConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  // 覆盖常见的网络/连接类错误关键词
  return (
    msg.includes("connection error") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("socket hang up") ||
    msg.includes("llm did not return") ||
    msg.includes("llm stream idle") ||
    msg.includes("llm returned an empty stream") ||
    msg.includes("stream was interrupted") ||
    msg.includes("stream_read_error") ||
    msg.includes("upstream_stream_read_error")
  );
}

function mapSessionFailureType(sessionState: SessionStateError["sessionState"]): FailureType {
  if (sessionState === "session_expired") {
    return "session_expired";
  }

  if (sessionState === "account_identity_mismatch") {
    return "account_identity_mismatch";
  }

  return "login_required";
}

function normalizeResumeAnchor(anchor: unknown, fallbackUrl: string) {
  if (anchor && typeof anchor === "object" && "stage" in anchor) {
    return anchor as PublishResumeAnchor;
  }

  return {
    stage: "login_checking",
    currentUrl: fallbackUrl
  } satisfies PublishResumeAnchor;
}

function resolveNotificationTriggerStage(input: {
  resumeAnchorJson?: string | null;
  preferredStage?: string | JobStage | null;
  fallbackStage: string;
}) {
  const resumeAnchor = safeParseJson<{ stage?: string | null } | null>(input.resumeAnchorJson ?? "", null);
  return resumeAnchor?.stage ?? input.preferredStage ?? input.fallbackStage;
}

function resolveNotificationEntryUrl(input: {
  resumeAnchorJson?: string | null;
  questionUrl?: string | null;
  finalUrl?: string | null;
}) {
  const resumeAnchor = safeParseJson<{ currentUrl?: string | null } | null>(input.resumeAnchorJson ?? "", null);
  return resumeAnchor?.currentUrl ?? input.questionUrl ?? input.finalUrl ?? null;
}

function pickVerificationUrl(
  jobDetail: Pick<JobDetail, "finalUrl" | "resumeAnchorJson">,
  failure: {
    currentUrl: string | null;
    meta: Record<string, unknown>;
  }
) {
  const failureResumeAnchor =
    failure.meta.resumeAnchor && typeof failure.meta.resumeAnchor === "object"
      ? (failure.meta.resumeAnchor as { currentUrl?: unknown }).currentUrl
      : null;
  const storedResumeAnchor = safeParseJson<{ currentUrl?: string | null } | null>(jobDetail.resumeAnchorJson ?? "", null);

  const candidates = [
    failure.currentUrl,
    typeof failureResumeAnchor === "string" ? failureResumeAnchor : null,
    jobDetail.finalUrl,
    storedResumeAnchor?.currentUrl ?? null
  ];

  return candidates.find((url): url is string => Boolean(url && url.includes("/answer/"))) ?? null;
}

function logExecutionContext(input: {
  jobId: number;
  accountId: number;
  stage: string;
  traceId: string;
  attemptNo: number;
}) {
  console.log(
    JSON.stringify({
      type: "job_trace",
      job_id: input.jobId,
      account_id: input.accountId,
      current_stage: input.stage,
      trace_id: input.traceId,
      attempt_id: input.attemptNo
    })
  );
}

function toAccountPromptContext(account: WorkerAccount): AccountPromptContext {
  return {
    accountId: account.id,
    accountName: account.name,
    zhihuUserName: account.zhihuUserName
  };
}

function readWriterPromptSourceAccountId(account: object): number | null {
  const value = (account as { writerPromptSourceAccountId?: number | null }).writerPromptSourceAccountId;
  return typeof value === "number" ? value : null;
}

function isLoginBlockedAccount(account: Pick<WorkerAccount, "status">) {
  return account.status === "manual_login_required" || account.status === "session_expired";
}

function isCoolingDown(account: Pick<WorkerAccount, "cooldownUntil"> | { cooldownUntil?: string | Date | null }) {
  if (!account.cooldownUntil) {
    return false;
  }

  const timestamp = new Date(account.cooldownUntil).valueOf();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

export function shouldHarvestAccountPool(input: {
  activeCandidateCount: number;
  hasInFlightPrepare?: boolean;
  hasImminentJobs?: boolean;
}) {
  return input.activeCandidateCount <= 0;
}

function countHoldersByAccount(holders: Array<{ accountId: number }>) {
  const counts = new Map<number, number>();
  for (const holder of holders) {
    counts.set(holder.accountId, (counts.get(holder.accountId) ?? 0) + 1);
  }
  return counts;
}

function pickHarvestBrowserAccount<
  TAccount extends { id: number; profileDir?: string | null }
>(
  accounts: TAccount[],
  blockedAccountIds: Set<number>,
  demand: Array<{ accountId: number; neededCount: number }>
) {
  const demandIds = new Set(demand.map((item) => item.accountId));
  return (
    accounts.find((account) => demandIds.has(account.id) && !blockedAccountIds.has(account.id) && account.profileDir) ??
    accounts.find((account) => !blockedAccountIds.has(account.id) && account.profileDir) ??
    null
  );
}

export function selectAccountScopedPrepareJobs<
  TJob extends { id: number; accountId: number },
  TAccount extends { id: number; status: string; cooldownUntil?: string | Date | null }
>(input: {
  jobs: TJob[];
  accountsById: Map<number, TAccount>;
  blockedAccountIds: Set<number>;
  inFlightJobIds: Set<number>;
  inFlightAccountIds: Set<number>;
  skipAccountIds?: Set<number>;
  limit: number;
}): Array<{ job: TJob; account: TAccount }> {
  const selected: Array<{ job: TJob; account: TAccount }> = [];
  const usedAccounts = new Set(input.inFlightAccountIds);

  for (const job of input.jobs) {
    if (selected.length >= input.limit) {
      break;
    }
    if (
      input.inFlightJobIds.has(job.id) ||
      input.blockedAccountIds.has(job.accountId) ||
      input.skipAccountIds?.has(job.accountId)
    ) {
      continue;
    }

    const account = input.accountsById.get(job.accountId);
    if (!account || isLoginBlockedAccount(account) || isCoolingDown(account)) {
      continue;
    }
    if (usedAccounts.has(job.accountId)) {
      continue;
    }

    selected.push({ job, account });
    if (selected.filter((item) => item.job.accountId === job.accountId).length >= MAX_PREPARE_JOBS_PER_ACCOUNT) {
      usedAccounts.add(job.accountId);
    }
  }

  return selected;
}

function resolveAccountBlockMessage(
  account: Pick<WorkerAccount, "name" | "statusReason" | "status" | "cooldownUntil">,
  options?: { manualLoginLocked?: boolean }
) {
  if (isCoolingDown(account)) {
    return (
      account.statusReason ??
      `账号「${account.name}」处于风控冷却期，自动调度将暂停到 ${formatBlockedUntil(account.cooldownUntil)}。`
    );
  }

  return (
    account.statusReason ??
    (options?.manualLoginLocked
      ? `账号「${account.name}」正在等待人工登录完成。`
      : `账号「${account.name}」需要先恢复登录态。`)
  );
}

function resolveTickAccountStatus(totalAccounts: number, blockedAccounts: number) {
  if (blockedAccounts <= 0) {
    return "active";
  }

  if (blockedAccounts >= totalAccounts) {
    return "manual_login_required";
  }

  return "partially_blocked";
}

function buildBlockedSummary(totalAccounts: number, blockedAccounts: number, blockedMessages: string[]) {
  if (blockedAccounts <= 0) {
    return null;
  }

  const firstMessage = Array.from(new Set(blockedMessages.filter(Boolean)))[0] ?? null;
  const prefix =
    blockedAccounts >= totalAccounts
      ? `${blockedAccounts} 个账号当前需要人工恢复或等待冷却。`
      : `${blockedAccounts} 个账号被登录或风控状态阻塞，其余账号继续执行。`;

  return firstMessage ? `${prefix} ${firstMessage}` : prefix;
}

function resolveRiskCooldownHours(failureType?: FailureType) {
  if (
    failureType === "challenge_required" ||
    failureType === "session_expired" ||
    failureType === "account_identity_mismatch"
  ) {
    return 12;
  }

  return 6;
}

function formatBlockedUntil(value: string | null) {
  if (!value) {
    return "冷却结束";
  }

  return new Date(value).toLocaleString("zh-CN", {
    hour12: false
  });
}

function mapFailureSeverity(failureType: FailureType) {
  if (
    failureType === "auth_required" ||
    failureType === "login_required" ||
    failureType === "session_expired" ||
    failureType === "account_identity_mismatch" ||
    failureType === "challenge_required"
  ) {
    return "high" as const;
  }

  if (failureType === "llm_connection_error" || failureType === "network_or_page_error" || failureType === "unknown_failure") {
    return "critical" as const;
  }

  return "medium" as const;
}

function buildFailureDiagnosticNote(message: string) {
  if (!message) {
    return null;
  }

  const fields = ["category", "code", "status", "syscall", "hostname"]
    .map((key) => {
      const matched = message.match(new RegExp(`${key}=([^|；\\n]+)`));
      if (!matched?.[1]) {
        return null;
      }

      return `${key}=${matched[1].trim()}`;
    })
    .filter((item): item is string => Boolean(item));

  if (fields.length <= 0) {
    return null;
  }

  return `LLM诊断：${fields.join(", ")}`;
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate adaptive retry backoff based on attempt count and failure type.
 * Prevents hammering the server and gives time for rate limits to clear.
 */
function calculateRetryBackoff(retryCount: number, failureType: string): number {
  // Base backoff: 30s for first retry, 60s for second
  const baseMs = 30_000;
  const multiplier = Math.pow(1.8, retryCount - 1); // 1.0 for 1st retry, 1.8 for 2nd
  
  // Scale up for risk-related failures
  const riskMultiplier = isRiskFailure(failureType) ? 2.0 : 1.0;
  
  const backoff = baseMs * multiplier * riskMultiplier;
  
  // Add jitter (±20%)
  const jitter = backoff * 0.2 * (Math.random() - 0.5);
  
  // Cap at 3 minutes
  return Math.min(backoff + jitter, 180_000);
}

/**
 * Check if the failure type is risk-related (needs longer backoff)
 */
function isRiskFailure(failureType: string): boolean {
  const riskTypes = [
    'session_expired',
    'challenge_required',
    'account_identity_mismatch',
    'rate_limit_429',
    'forbidden_403'
  ];
  return riskTypes.includes(failureType);
}

/**
 * Validate that no two accounts share the same profile directory.
 * Returns critical issues if profile sharing is detected.
 */
export function validateProfileOneToOne(
  accounts: Array<{ id: string | number; profileDir?: string | null }>,
  profileRoot?: string
): Array<{ type: 'profile_shared'; severity: 'critical'; message: string; accounts: (string | number)[] }> {
  const profileMap = new Map<string, (string | number)[]>();
  
  for (const account of accounts) {
    if (!account.profileDir) continue;
    
    const resolved = profileRoot 
      ? (path.isAbsolute(account.profileDir) ? account.profileDir : path.join(profileRoot, account.profileDir))
      : account.profileDir;
    
    if (!profileMap.has(resolved)) {
      profileMap.set(resolved, []);
    }
    profileMap.get(resolved)!.push(account.id);
  }
  
  const issues: Array<{ type: 'profile_shared'; severity: 'critical'; message: string; accounts: (string | number)[] }> = [];
  
  for (const [profile, accountIds] of profileMap) {
    if (accountIds.length > 1) {
      issues.push({
        type: 'profile_shared',
        severity: 'critical',
        message: `Profile ${profile} is shared by accounts: ${accountIds.join(', ')}. Each account must have a unique profile.`,
        accounts: accountIds
      });
    }
  }
  
  return issues;
}
