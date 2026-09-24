import fs from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  AccountSoulService,
  AccountRepository,
  BrowserSkillService,
  DashboardService,
  FeishuNotificationService,
  FailureResolutionService,
  HumanizerService,
  JobRepository,
  LlmService,
  OpsDiagnosisService,
  OpsIncidentRepository,
  OpsIncidentService,
  OpsScannerService,
  PlaywrightToolRuntime,
  PromptRepository,
  PromptService,
  PublishService,
  ReviewService,
  ScheduleRepository,
  ScheduleService,
  SessionStateError,
  SessionService,
  TopicBatchPlannerService,
  TopicDiscoveryService,
  TopicPipelineService,
  TopicRepository,
  TopicReviewService,
  WorkerRunner,
  VideoAgentService,
  VideoCaseService,
  VideoRepository,
  VideoService,
  VideoWorkerRunner,
  ZhihuNoteAgentService,
  applySchemaMigrations,
  getAppConfig,
  getMysqlPool,
  safeParseJson
} from "@zhihu-mvp/core";
import {
  accountRecoveryActionSchema,
  createVideoProjectSchema,
  createVideoCaseIntentSchema,
  createVideoTopicBatchSchema,
  createAccountSchema,
  createJobSchema,
  createPromptDraftSchema,
  refillVideoTopicBatchSchema,
  generateVideoScriptSchema,
  generateVideoCaseReviewSchema,
  type FailureType,
  promptSetNameSchema,
  promptTestRunSchema,
  reselectTopicSchema,
  rescheduleJobSchema,
  retryJobSchema,
  saveAccountSoulSchema,
  saveVideoScriptPackSchema,
  saveVideoTopicFeedbackSchema,
  saveVisualRenderPlanSchema,
  updateAccountSchema,
  updatePromptDraftSchema,
  videoFeedbackDocumentInputSchema,
  videoHotspotScoreSchema,
  zhihuNoteAgentApplySchema,
  zhihuNoteAgentGenerateSchema
} from "@zhihu-mvp/shared";

const app = Fastify({ logger: true });
const pool = getMysqlPool();
await applySchemaMigrations(pool);

const promptRepository = new PromptRepository(pool);
const promptService = new PromptService(promptRepository);
const llmService = new LlmService(promptRepository);
const accountSoulService = new AccountSoulService();
const accountRepository = new AccountRepository(pool);
const scheduleRepository = new ScheduleRepository(pool);
const scheduleService = new ScheduleService(scheduleRepository, accountRepository);
const jobRepository = new JobRepository(pool);
const topicRepository = new TopicRepository(pool);
const topicBatchPlannerService = new TopicBatchPlannerService(llmService, topicRepository);
const topicReviewService = new TopicReviewService(llmService);
const reviewService = new ReviewService(llmService);
const humanizerService = new HumanizerService(jobRepository);
const zhihuNoteAgentService = new ZhihuNoteAgentService(llmService);
const topicPipelineService = new TopicPipelineService(
  llmService,
  topicRepository,
  topicBatchPlannerService,
  topicReviewService,
  reviewService,
  humanizerService
);
const runtime = new PlaywrightToolRuntime(jobRepository);
const browserSkillService = new BrowserSkillService(runtime, jobRepository);
const sessionService = new SessionService(browserSkillService, llmService);
const topicDiscoveryService = new TopicDiscoveryService(topicRepository, browserSkillService, sessionService, llmService);
const publishService = new PublishService(llmService, browserSkillService, sessionService);
const feishuNotificationService = new FeishuNotificationService();
const videoRepository = new VideoRepository(pool);
const videoAgentService = new VideoAgentService(llmService);
const videoService = new VideoService(videoRepository, videoAgentService, feishuNotificationService);
const videoCaseService = new VideoCaseService(videoRepository);
const videoWorkerRunner = new VideoWorkerRunner(videoRepository, videoService, videoAgentService);
const failureResolutionService = new FailureResolutionService(llmService);
const opsIncidentRepository = new OpsIncidentRepository(pool);
const opsDiagnosisService = new OpsDiagnosisService();
const opsIncidentService = new OpsIncidentService(
  opsIncidentRepository,
  opsDiagnosisService,
  feishuNotificationService
);
const dashboardService = new DashboardService(
  accountRepository,
  scheduleService,
  scheduleRepository,
  jobRepository,
  topicRepository
);
const workerRunner = new WorkerRunner(
  scheduleService,
  scheduleRepository,
  accountRepository,
  topicRepository,
  topicDiscoveryService,
  topicPipelineService,
  jobRepository,
  publishService,
  failureResolutionService,
  llmService,
  feishuNotificationService,
  opsIncidentService
);
const opsScannerService = new OpsScannerService(
  opsIncidentService,
  jobRepository,
  accountRepository,
  scheduleService
);

await app.register(cors, {
  origin: true
});

app.setErrorHandler((error, _request, reply) => {
  const statusCode =
    typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode?: unknown }).statusCode)
      : 500;

  reply.status(statusCode).send({
    error: {
      code: statusCode,
      message: error instanceof Error ? error.message : "服务端发生未知错误"
    }
  });
});

await promptService.bootstrapDefaults();
await accountRepository.ensureDefaultAccount();
await accountRepository.normalizeProfileDirs();
await scheduleService.bootstrapTodaySchedule();

app.get("/health", async () => ({
  ok: true,
  service: "api"
}));

app.post("/notifications/feishu/test", async () => feishuNotificationService.sendTestNotification());

app.get("/ops/summary", async () => ({
  summary: await opsIncidentService.getSummary()
}));

app.get("/ops/incidents", async () => ({
  incidents: await opsIncidentService.listIncidents()
}));

app.get("/ops/incidents/:id", async (request) => {
  const params = request.params as { id: string };
  return {
    incident: await opsIncidentService.getIncidentById(Number(params.id))
  };
});

app.post("/ops/scan", async () => {
  const running = opsScannerService.isScanRunning();
  const startedAt = new Date().toISOString();

  void opsScannerService.startScan().catch((error) => {
    app.log.error(error, "ops scan failed");
  });

  return {
    ok: true,
    running: true,
    accepted: !running,
    startedAt,
    lastSummary: opsScannerService.getLastSummary()
  };
});

app.get("/dashboard/summary", async (request) => ({
  summary: await dashboardService.getSummary(parseOptionalAccountIdFromQuery(request))
}));

app.get("/accounts", async () => ({
  accounts: await accountRepository.listAccounts()
}));

app.post("/accounts", async (request) => {
  const body = createAccountSchema.parse(request.body ?? {});
  const account = await accountRepository.createAccount({
    name: body.name.trim(),
    zhihuUserName: body.zhihuUserName ? body.zhihuUserName.trim() : null
  });

  if (!account) {
    throw new Error("账号已创建，但读取账号信息失败。");
  }

  await accountSoulService.ensureSoulDocument(account);
  await scheduleService.bootstrapTodaySchedule();

  return {
    ok: true,
    account
  };
});

app.delete("/accounts/:id", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);

  if (!Number.isInteger(accountId) || accountId <= 0) {
    const error = new Error("账号 ID 不合法。") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  const existingAccount = await accountRepository.getAccount(accountId);
  if (!existingAccount) {
    const error = new Error("账号不存在。") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  const result = await accountRepository.deleteAccount(accountId);
  if (!result.deleted) {
    const summary = result.summary;
    const reasons = [
      summary?.publishJobCount ? `${summary.publishJobCount} 个任务` : null,
      summary?.topicCandidateCount ? `${summary.topicCandidateCount} 条题目候选` : null,
      summary?.answeredTopicCount ? `${summary.answeredTopicCount} 条历史回答记录` : null
    ].filter(Boolean);
    const detail = reasons.length ? `当前账号下还有 ${reasons.join("、")}。` : "";
    const error = new Error(`只有空账号才允许删除。${detail}`.trim()) as Error & { statusCode?: number };
    error.statusCode = 409;
    throw error;
  }

  await accountSoulService.deleteSoulDocument(accountId);

  return {
    ok: true,
    deletedAccountId: accountId,
    cleanupWarning: result.cleanupWarning,
    nextAccountId: (await accountRepository.getPrimaryAccount())?.id ?? null
  };
});

app.get("/schedule/today", async () => ({
  slots: await scheduleService.getTodaySchedule()
}));

app.get("/schedule/week", async () => ({
  slots: await scheduleService.getWeekSchedule()
}));

app.get("/topics", async (request) => ({
  topics: await topicRepository.listTopics(100, parseOptionalAccountIdFromQuery(request))
}));

app.get("/topics/batch-plan", async (request) => {
  const accountId = parseOptionalAccountIdFromQuery(request);
  const account = accountId ? await accountRepository.getAccount(accountId) : null;
  const soulDocument = account ? await accountSoulService.ensureSoulDocument(account) : null;

  return {
    plan: await topicBatchPlannerService.getCurrentBatchPlan(undefined, {
      accountId,
      accountContext: account
        ? {
            accountId: account.id,
            accountName: account.name,
            zhihuUserName: account.zhihuUserName
          }
        : null,
      accountSoulMarkdown: soulDocument?.markdown ?? null
    })
  };
});

app.get("/drafts", async (request) => ({
  drafts: await topicRepository.listDrafts(100, parseOptionalAccountIdFromQuery(request))
}));

app.get("/jobs", async () => ({
  jobs: await jobRepository.listJobs()
}));

app.get("/publish-jobs", async () => ({
  jobs: await jobRepository.listPublishJobs()
}));

app.post("/jobs", async (request) => {
  const body = createJobSchema.parse(request.body ?? {});
  const account = await accountRepository.getAccount(body.accountId);
  if (!account) {
    throw new Error("指定账号不存在。");
  }

  const promptSnapshot = await llmService.getPromptSnapshotForAccount({
    writerPromptVersionId: account.writerPromptVersionId
  });
  const soulDocument = await accountSoulService.ensureSoulDocument(account);
  const promptSnapshotJson = JSON.stringify(promptSnapshot);

  const slot =
    (await scheduleService.getNextUnassignedSlot(body.accountId)) ??
    ({
      id: await scheduleRepository.createAdhocSlot(body.accountId, new Date(), "pending"),
      accountId: body.accountId,
      accountName: account.name,
      scheduledAt: new Date().toISOString(),
      status: "pending",
      publishJobId: null,
      title: null
    } as const);

  const jobId = await jobRepository.createQueuedJob({
    accountId: body.accountId,
    scheduledAt: slot.scheduledAt,
    promptVersionSnapshotJson: promptSnapshotJson,
    soulVersion: soulDocument.version,
    soulMarkdownSnapshot: soulDocument.markdown
  });
  await scheduleRepository.assignJobToSlot(slot.id, jobId);

  const job = await jobRepository.getJobById(jobId);
  if (!job) {
    throw new Error("任务已创建，但读取任务详情失败。");
  }

  return {
    jobId: job.id,
    status: job.status,
    displayStatus: job.displayStatus,
    currentStage: job.currentStage ?? "queued",
    scheduledAt: job.scheduledAt,
    message: "任务已创建，等待 Worker 推进选题、写作、审核和发布。"
  };
});

app.patch("/accounts/:id", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);
  const body = updateAccountSchema.parse(request.body ?? {});

  const existingAccount = await accountRepository.getAccount(accountId);
  if (!existingAccount) {
    throw new Error("账号不存在。");
  }

  const writerPromptVersionId = body.writerPromptVersionId;
  if (writerPromptVersionId != null) {
    const promptVersion = await promptRepository.getPromptVersionById(writerPromptVersionId);
    if (!promptVersion || promptVersion.set_name !== "writer_agent") {
      throw new Error("只能绑定 writer_agent 的 Prompt 版本。");
    }
  }

  await accountRepository.updateAccount(accountId, {
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "zhihuUserName")
      ? { zhihuUserName: body.zhihuUserName ? body.zhihuUserName.trim() : null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "writerPromptVersionId")
      ? { writerPromptVersionId: body.writerPromptVersionId ?? null }
      : {})
  });

  return {
    ok: true,
    account: await accountRepository.getAccount(accountId)
  };
});

/*
app.get("/accounts/:id/soul", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);
  const account = await accountRepository.getAccount(accountId);
  if (!account) {
    throw new Error("璐﹀彿涓嶅瓨鍦ㄣ€?);
  }

  return {
    account,
    soulDocument: await accountSoulService.ensureSoulDocument(account)
  };
});

app.put("/accounts/:id/soul", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);
  const body = saveAccountSoulSchema.parse(request.body ?? {});
  const account = await accountRepository.getAccount(accountId);
  if (!account) {
    throw new Error("璐﹀彿涓嶅瓨鍦ㄣ€?);
  }

  return {
    ok: true,
    soulDocument: await accountSoulService.saveSoulDocument(account, {
      coreIdentity: body.coreIdentity,
      targetReader: body.targetReader,
      voiceTraits: body.voiceTraits,
      worldview: body.worldview,
      proofAnchors: body.proofAnchors,
      signatureMoves: body.signatureMoves,
      productMentionPolicy: body.productMentionPolicy,
      hardBoundaries: body.hardBoundaries,
      tabooLexicon: body.tabooLexicon,
      exemplarLines: body.exemplarLines,
      updateReason: body.updateReason
    })
  };
});

*/

app.get("/accounts/:id/soul", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);
  const account = await accountRepository.getAccount(accountId);
  if (!account) {
    throw new Error("Account does not exist.");
  }

  return {
    account,
    soulDocument: await accountSoulService.ensureSoulDocument(account)
  };
});

app.put("/accounts/:id/soul", async (request) => {
  const params = request.params as { id: string };
  const accountId = Number(params.id);
  const body = saveAccountSoulSchema.parse(request.body ?? {});
  const account = await accountRepository.getAccount(accountId);
  if (!account) {
    throw new Error("Account does not exist.");
  }

  return {
    ok: true,
    soulDocument: await accountSoulService.saveSoulDocument(account, {
      coreIdentity: body.coreIdentity,
      targetReader: body.targetReader,
      voiceTraits: body.voiceTraits,
      worldview: body.worldview,
      proofAnchors: body.proofAnchors,
      signatureMoves: body.signatureMoves,
      productMentionPolicy: body.productMentionPolicy,
      hardBoundaries: body.hardBoundaries,
      tabooLexicon: body.tabooLexicon,
      exemplarLines: body.exemplarLines,
      updateReason: body.updateReason
    })
  };
});

app.post("/accounts/:id/note-agent/generate", async (request) => {
  const account = await requireAccountById((request.params as { id: string }).id);
  const body = zhihuNoteAgentGenerateSchema.parse(request.body ?? {});

  return {
    draft: await zhihuNoteAgentService.generateDraft(account, body)
  };
});

app.post("/accounts/:id/note-agent/apply", async (request) => {
  const account = await requireAccountById((request.params as { id: string }).id);
  const body = zhihuNoteAgentApplySchema.parse(request.body ?? {});

  return {
    ok: true,
    result: await zhihuNoteAgentService.applyDraft(account, body)
  };
});

app.get("/jobs/:id", async (request) => {
  const params = request.params as { id: string };
  return {
    job: await jobRepository.getJobById(Number(params.id))
  };
});

app.get("/jobs/:id/publish-attempts", async (request) => {
  const params = request.params as { id: string };
  return {
    attempts: await jobRepository.listPublishAttempts(Number(params.id))
  };
});

app.get("/jobs/:id/artifacts", async (request) => {
  const params = request.params as { id: string };
  return {
    artifacts: await jobRepository.listArtifacts(Number(params.id))
  };
});

app.get("/jobs/:id/tool-traces", async (request) => {
  const params = request.params as { id: string };
  return {
    traces: await jobRepository.listToolTraces(Number(params.id))
  };
});

app.get("/jobs/:id/skill-runs", async (request) => {
  const params = request.params as { id: string };
  return {
    skillRuns: await jobRepository.listSkillRuns(Number(params.id))
  };
});

app.post("/jobs/:id/retry", async (request) => {
  const params = request.params as { id: string };
  retryJobSchema.parse(request.body ?? {});

  const jobId = Number(params.id);
  await jobRepository.retryJob(jobId);
  const slot = await scheduleRepository.getSlotByJobId(jobId);
  if (slot) {
    await scheduleRepository.updateSlotStatus(slot.id, "pending");
  }

  return { ok: true };
});

app.patch("/jobs/:id/schedule", async (request) => {
  const params = request.params as { id: string };
  const body = rescheduleJobSchema.parse(request.body ?? {});
  const jobId = Number(params.id);
  const job = await jobRepository.getJobById(jobId);
  if (!job) {
    throw new Error("任务不存在。");
  }
  if (job.status === "published") {
    throw new Error("已发布任务不允许再调整发布时间。");
  }

  const scheduledAt = new Date(body.scheduledAt);
  if (Number.isNaN(scheduledAt.valueOf())) {
    throw new Error("scheduledAt 必须是有效的时间。");
  }

  await jobRepository.updateScheduledAt(jobId, scheduledAt);

  const slot = await scheduleRepository.getSlotByJobId(jobId);
  if (slot) {
    await scheduleRepository.updateSlotScheduledAt(slot.id, scheduledAt);
  }

  return {
    ok: true,
    job: await jobRepository.getJobById(jobId),
    slot: slot ? await scheduleRepository.getSlotById(slot.id) : null
  };
});

app.post("/jobs/:id/reselect-topic", async (request) => {
  const params = request.params as { id: string };
  reselectTopicSchema.parse(request.body ?? {});
  const jobId = Number(params.id);
  const job = await jobRepository.getJobById(jobId);
  if (!job) {
    throw new Error("任务不存在。");
  }

  const account = await accountRepository.getAccount(job.accountId);

  const promptSnapshot =
    safeParseJson(
      job.promptVersionSnapshotJson ?? "",
      await llmService.getPromptSnapshotForAccount({
        writerPromptVersionId: account?.writerPromptVersionId ?? null
      })
    ) ??
    (await llmService.getPromptSnapshotForAccount({
      writerPromptVersionId: account?.writerPromptVersionId ?? null
    }));
  const promptSnapshotJson = JSON.stringify(promptSnapshot);
  const soulDocument = account ? await accountSoulService.ensureSoulDocument(account) : null;
  const soulVersion = job.soulVersion ?? soulDocument?.version ?? null;
  const accountSoulMarkdown = job.soulMarkdownSnapshot ?? soulDocument?.markdown ?? null;

  if (!job.soulMarkdownSnapshot && soulDocument) {
    await jobRepository.updateJobStatus(jobId, job.status, {
      currentStage: job.currentStage ?? job.status,
      soulVersion: soulDocument.version,
      soulMarkdownSnapshot: soulDocument.markdown
    });
  }

  const replacement = await topicPipelineService.prepareNextPublishableDraft({
    publishJobId: jobId,
    promptSnapshot,
    accountSoulMarkdown,
    accountContext: account
      ? {
          accountId: account.id,
          accountName: account.name,
          zhihuUserName: account.zhihuUserName
        }
      : null,
    onStage: async (stage) => {
      await jobRepository.updateJobStatus(jobId, stage, {
        currentStage: stage,
        promptVersionSnapshotJson: promptSnapshotJson,
        failureReason: null,
        lastErrorType: null
      });
    }
  });

  if (!replacement) {
    throw new Error("当前没有新的可替换选题。");
  }

  if (replacement.kind !== "ready") {
    throw new Error(replacement.reason || "Replacement topic did not produce a publishable draft.");
  }

  await jobRepository.replaceJobPayload(jobId, {
    topicCardId: replacement.topicCardId,
    reviewId: replacement.reviewId,
    title: replacement.title,
    promptVersionSnapshotJson: promptSnapshotJson
  });

  if (!job.soulMarkdownSnapshot && soulVersion != null && accountSoulMarkdown) {
    await jobRepository.updateJobStatus(jobId, "review_passed", {
      currentStage: "review_passed",
      soulVersion,
      soulMarkdownSnapshot: accountSoulMarkdown,
      promptVersionSnapshotJson: promptSnapshotJson
    });
  }

  const slot = await scheduleRepository.getSlotByJobId(jobId);
  if (slot && slot.status !== "published") {
    await scheduleRepository.updateSlotStatus(slot.id, "pending");
  }

  return { ok: true };
});

app.post("/jobs/:id/run-now", async (request) => {
  const params = request.params as { id: string };
  const jobId = Number(params.id);

  return {
    ok: true,
    result: await workerRunner.runJobNow(jobId)
  };
});

app.get("/account/status", async (request) => ({
  account: await dashboardService.getAccountView(parseOptionalAccountIdFromQuery(request))
}));

app.post("/account/manual-login/start", async (request) => {
  const body = accountRecoveryActionSchema.parse(request.body);
  const account = await accountRepository.getAccount(body.accountId);
  if (!account?.profileDir) {
    throw new Error("账号没有配置浏览器 Profile 目录。");
  }

  const targetJob = await resolveRecoveryTargetJob(body.accountId, body.publishJobId);
  const returnUrl = getReturnUrl(targetJob);
  const preservedChallengePage = await shouldUsePreservedChallengePage(account.profileDir, targetJob);

  if (preservedChallengePage) {
    const message =
      "检测到这是发布过程中触发的安全验证或反爬挑战，系统已经保留原发布页面，不会自动关闭。请直接回到刚才那个浏览器窗口完成验证，不要再新开人工登录窗口。处理完后点击“登录成功，继续下一步”即可。";
    await accountRepository.markManualLoginRequired(body.accountId, message);
    return {
      browserMode: null,
      loginUrl: returnUrl,
      preservedExistingPage: true,
      message
    };
  }

  await accountRepository.markManualLoginRequired(body.accountId, "需要人工确认知乎登录状态。");
  if (body.publishJobId) {
    await jobRepository.updateJobStatus(body.publishJobId, "manual_login_required", {
      currentStage: "manual_login_required",
      failureReason: "等待人工登录恢复。",
      resumeAnchorJson: returnUrl ? JSON.stringify({ stage: "login_checking", currentUrl: returnUrl }) : null,
      lastErrorType: "login_required"
    });

    const slot = await scheduleRepository.getSlotByJobId(body.publishJobId);
    if (slot) {
      await scheduleRepository.updateSlotStatus(slot.id, "manual_login_required");
    }
  }

  return sessionService.startManualLoginFlow(body.accountId, account.profileDir, returnUrl);
});

app.post("/account/recovery/confirm", async (request) => {
  const body = accountRecoveryActionSchema.parse(request.body);
  const account = await accountRepository.getAccount(body.accountId);
  if (!account?.profileDir) {
    throw new Error("\u8d26\u53f7\u6ca1\u6709\u914d\u7f6e\u6d4f\u89c8\u5668 Profile \u76ee\u5f55\u3002");
  }

  const targetJob = await resolveRecoveryTargetJob(body.accountId, body.publishJobId);
  const returnUrl = getReturnUrl(targetJob);
  const promptSnapshot = targetJob?.promptVersionSnapshotJson
    ? safeParseJson(targetJob.promptVersionSnapshotJson, {})
    : undefined;
  const checkUrl = getRecoveryCheckUrl();
  const preservedChallengePage = await shouldUsePreservedChallengePage(account.profileDir, targetJob);

  try {
    if (preservedChallengePage) {
      await accountRepository.markActive(body.accountId);

      if (targetJob) {
        await jobRepository.updateJobStatus(targetJob.id, "login_checking", {
          currentStage: "login_checking",
          failureReason: null,
          lastErrorType: null
        });

        const slot = await scheduleRepository.getSlotByJobId(targetJob.id);
        if (slot) {
          await scheduleRepository.updateSlotStatus(slot.id, "pending");
        }
      }

      const sessionKey = targetJob ? buildPublishSessionKey(body.accountId, targetJob.id) : null;
      const resumedInCurrentProcess = sessionKey ? publishService.hasOpenSession(sessionKey) : false;
      const summary = resumedInCurrentProcess ? await workerRunner.tick() : null;

      return {
        ok: true,
        blockedByLogin: false,
        resumedByWorker: resumedInCurrentProcess,
        message: resumedInCurrentProcess
          ? "已记录你完成了安全验证，系统会继续复用当前保留的发布页面推进任务。"
          : "已记录你完成了安全验证。为避免关闭原页面，接口不会另开浏览器抢占 Profile；任务会在下一轮 worker 继续推进，如果你当前没有常驻 worker，可以手动触发一次执行队列。",
        summary
      };
    }

    const recovery = await sessionService.confirmRecoveredSession({
      accountId: body.accountId,
      profileDir: account.profileDir,
      checkUrl,
      returnUrl,
      publishJobId: body.publishJobId ?? null,
      promptSnapshot,
      expectedZhihuUserName: account.zhihuUserName,
      accountName: account.name
    });

    await accountRepository.markActive(body.accountId);

    if (body.publishJobId) {
      await jobRepository.updateJobStatus(body.publishJobId, "login_checking", {
        currentStage: "login_checking",
        failureReason: null,
        lastErrorType: null
      });

      const slot = await scheduleRepository.getSlotByJobId(body.publishJobId);
      if (slot) {
        await scheduleRepository.updateSlotStatus(slot.id, "pending");
      }
    }

    const summary = await workerRunner.tick();

    return {
      ok: true,
      blockedByLogin: false,
      message: "\u5df2\u786e\u8ba4\u767b\u5f55\u72b6\u6001\uff0c\u7cfb\u7edf\u5c06\u7ee7\u7eed\u63a8\u8fdb\u6d41\u7a0b\u3002",
      sessionState: recovery.sessionState,
      summary
    };
  } catch (error) {
    const classifiedError = classifyRecoveryError(error);
    await accountRepository.markManualLoginRequired(body.accountId, classifiedError.message);

    if (body.publishJobId) {
      await jobRepository.updateJobStatus(body.publishJobId, "manual_login_required", {
        currentStage: "manual_login_required",
        failureReason: classifiedError.message,
        resumeAnchorJson: returnUrl ? JSON.stringify({ stage: "login_checking", currentUrl: returnUrl }) : null,
        lastErrorType: classifiedError.failureType
      });

      const slot = await scheduleRepository.getSlotByJobId(body.publishJobId);
      if (slot) {
        await scheduleRepository.updateSlotStatus(slot.id, "manual_login_required");
      }
    }

    try {
      await opsIncidentService.reportIncident({
        source: "manual_login",
        severity: classifiedError.blockedByLogin ? "high" : "medium",
        serviceName: "zhihu-api",
        accountId: body.accountId,
        jobId: body.publishJobId ?? null,
        failureType: classifiedError.failureType,
        title: `Manual login recovery failed for account #${body.accountId}`,
        currentStage: "manual_login_required",
        triggerStage: "manual_login_required",
        entryUrl: returnUrl,
        questionTitle: targetJob?.questionTitle ?? targetJob?.title ?? null,
        rawErrorExcerpt: classifiedError.message,
        evidence: {
          blockedByLogin: classifiedError.blockedByLogin,
          checkUrl,
          returnUrl
        }
      });
    } catch (reportError) {
      app.log.error(reportError, "failed to report manual login incident");
    }

    return {
      ok: false,
      blockedByLogin: classifiedError.blockedByLogin,
      message: classifiedError.message,
      summary: null
    };
  }
});

app.get("/prompt-sets", async () => ({
  promptSets: await promptService.listPromptSets()
}));

app.get("/prompt-sets/:name", async (request) => {
  const params = request.params as { name: string };
  const name = promptSetNameSchema.parse(params.name);
  return {
    promptSet: await promptService.getPromptSet(name)
  };
});

app.post("/prompt-sets/:name/drafts", async (request) => {
  const params = request.params as { name: string };
  const name = promptSetNameSchema.parse(params.name);
  const body = createPromptDraftSchema.parse(request.body);
  return {
    promptVersionId: await promptService.createDraft(name, body)
  };
});

app.patch("/prompt-versions/:id", async (request) => {
  const params = request.params as { id: string };
  const body = updatePromptDraftSchema.parse(request.body);
  await promptService.updateDraft(Number(params.id), body);
  return { ok: true };
});

app.post("/prompt-versions/:id/test", async (request) => {
  const params = request.params as { id: string };
  const body = promptTestRunSchema.parse({
    ...(request.body as Record<string, unknown>),
    promptVersionId: Number(params.id)
  });
  return promptService.testPrompt(body);
});

app.post("/prompt-versions/:id/activate", async (request) => {
  const params = request.params as { id: string };
  await promptService.activatePromptVersion(Number(params.id));
  return { ok: true };
});

app.post("/prompt-versions/:id/rollback-target", async (request) => {
  const params = request.params as { id: string };
  await promptService.rollbackToVersion(Number(params.id));
  return { ok: true };
});

app.get("/video-hub/summary", async () => ({
  summary: await videoService.getHubSummary()
}));

app.get("/video-hub/topic-batches", async () => ({
  batches: await videoRepository.listTopicBatches()
}));

app.post("/video-hub/topic-batches", async (request) => {
  const body = createVideoTopicBatchSchema.parse(request.body ?? {});
  return {
    batch: await videoService.createTopicBatch(body)
  };
});

app.post("/video-hub/topic-batches/:id/refill", async (request) => {
  const params = request.params as { id: string };
  const body = refillVideoTopicBatchSchema.parse(request.body ?? {});
  return {
    batch: await videoService.refillTopicBatch(params.id, body)
  };
});

app.get("/video-hub/topic-candidates", async (request) => {
  const query = request.query as { batchId?: string; limit?: string };
  return {
    candidates: await videoRepository.listTopicCandidates(Number(query.limit ?? 50), query.batchId ?? null)
  };
});

app.post("/video-hub/hotspots/score", async (request) => {
  const body = videoHotspotScoreSchema.parse(request.body ?? {});
  return {
    result: await videoService.scoreHotspot(body)
  };
});

app.post("/video-hub/topic-candidates/:id/feedback", async (request) => {
  const params = request.params as { id: string };
  const body = saveVideoTopicFeedbackSchema.parse(request.body ?? {});
  return {
    candidate: await videoService.saveTopicFeedback(params.id, body)
  };
});

app.get("/video-hub/projects", async () => ({
  projects: await videoRepository.listProjects()
}));

app.post("/video-hub/projects", async (request) => {
  const body = createVideoProjectSchema.parse(request.body ?? {});
  return {
    project: await videoService.createProject(body.topicCandidateId, body.title ?? null)
  };
});

app.get("/video-hub/projects/:id", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoRepository.getProjectDetail(params.id)
  };
});

app.get("/video-hub/projects/:id/case-intents", async (request) => {
  const params = request.params as { id: string };
  return {
    caseIntents: await videoCaseService.listCaseIntents(params.id)
  };
});

app.post("/video-hub/projects/:id/case-intents", async (request) => {
  const params = request.params as { id: string };
  const body = createVideoCaseIntentSchema.parse(request.body ?? {});
  return {
    caseIntent: await videoCaseService.createCaseIntent(params.id, body)
  };
});

app.get("/video-hub/projects/:id/case-packs", async (request) => {
  const params = request.params as { id: string };
  return {
    casePacks: await videoCaseService.listVerifiedCasePacks(params.id)
  };
});

app.post("/video-hub/projects/:id/case-review/generate", async (request) => {
  const params = request.params as { id: string };
  const body = generateVideoCaseReviewSchema.parse(request.body ?? {});
  return {
    casePack: await videoCaseService.generateVerifiedCasePack(params.id, body.caseIntentId ?? null)
  };
});

app.post("/video-hub/projects/:id/script/generate", async (request) => {
  const params = request.params as { id: string };
  const body = generateVideoScriptSchema.parse(request.body ?? {});
  return {
    project: await videoService.generateScript(params.id, body.revisionInstruction, body.verifiedCasePackId ?? null)
  };
});

app.put("/video-hub/projects/:id/script", async (request) => {
  const params = request.params as { id: string };
  const body = saveVideoScriptPackSchema.parse(request.body ?? {});
  return {
    project: await videoService.saveScript(params.id, body.scriptPack)
  };
});

app.post("/video-hub/projects/:id/script/confirm", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.confirmScript(params.id)
  };
});

app.post("/video-hub/projects/:id/render-plan/generate", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.generateVisualPlan(params.id)
  };
});

app.put("/video-hub/projects/:id/render-plan", async (request) => {
  const params = request.params as { id: string };
  const body = saveVisualRenderPlanSchema.parse(request.body ?? {});
  return {
    project: await videoService.saveVisualPlan(params.id, body.visualRenderPlan)
  };
});

app.post("/video-hub/projects/:id/render-plan/confirm", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.confirmVisualPlan(params.id)
  };
});

app.post("/video-hub/projects/:id/assets/enqueue", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.enqueueAssets(params.id)
  };
});

app.post("/video-hub/projects/:id/compose", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.enqueueComposition(params.id)
  };
});

app.post("/video-hub/projects/:id/approve", async (request) => {
  const params = request.params as { id: string };
  return {
    project: await videoService.approveProject(params.id)
  };
});

app.post("/video-hub/feedback-documents", async (request) => {
  const body = videoFeedbackDocumentInputSchema.parse(request.body ?? {});
  return {
    document: await videoService.createFeedbackDocument(body)
  };
});

app.get("/video-hub/assets/:id/content", async (request, reply) => {
  const params = request.params as { id: string };
  const asset = await videoRepository.getAsset(params.id);
  if (!asset?.filePath) {
    const error = new Error("Video asset file not found.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  const content = await fs.readFile(asset.filePath);
  return reply.type(asset.mimeType ?? "application/octet-stream").send(content);
});

app.post("/worker/tick", async () => ({
  summary: await workerRunner.tick(),
  videoSummary: await videoWorkerRunner.tick()
}));

await app.listen({
  host: "0.0.0.0",
  port: getAppConfig().apiPort
});

function getReturnUrl(job: Awaited<ReturnType<JobRepository["getJobById"]>>) {
  if (!job) {
    return null;
  }

  const resumeAnchor = safeParseJson<Record<string, unknown>>(job.resumeAnchorJson ?? "{}", {});
  const resumeUrl = sanitizeNavigationUrl(typeof resumeAnchor.currentUrl === "string" ? resumeAnchor.currentUrl : null);
  if (resumeUrl) {
    return resumeUrl;
  }

  return sanitizeNavigationUrl(job.questionUrl ?? null);
}

function getRecoveryCheckUrl() {
  return `${getAppConfig().zhihuBaseUrl}/settings/account`;
}

async function resolveRecoveryTargetJob(accountId: number, publishJobId?: number) {
  if (publishJobId) {
    return jobRepository.getJobById(publishJobId);
  }

  const blockedJobs = await jobRepository.listBlockedJobs(accountId);
  return blockedJobs[0] ? jobRepository.getJobById(blockedJobs[0].id) : null;
}

function buildPublishSessionKey(accountId: number, jobId: number) {
  return `publish-account-${accountId}-job-${jobId}`;
}

async function shouldUsePreservedChallengePage(
  profileDir: string,
  job: Awaited<ReturnType<JobRepository["getJobById"]>>
) {
  if (!job || !isChallengeRecoveryTarget(job)) {
    return false;
  }

  return hasOpenPlaywrightProfileLock(profileDir);
}

function isChallengeRecoveryTarget(job: Awaited<ReturnType<JobRepository["getJobById"]>>) {
  const combined = [job?.failureReason, job?.lastErrorType, job?.resumeAnchorJson, job?.questionUrl, job?.finalUrl]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  return (
    job?.lastErrorType === "challenge_required" ||
    combined.includes("account/unhuman") ||
    combined.includes("captcha") ||
    combined.includes("challenge") ||
    combined.includes("安全验证") ||
    combined.includes("异常验证") ||
    combined.includes("人机验证") ||
    combined.includes("滑块") ||
    combined.includes("风控") ||
    combined.includes("反爬")
  );
}

async function hasOpenPlaywrightProfileLock(profileDir: string) {
  const lockPath = path.join(profileDir, getAppConfig().browserChannel, ".playwright-profile.lock");
  try {
    await fs.access(lockPath);
    return true;
  } catch {
    return false;
  }
}

function classifyRecoveryError(error: unknown) {
  if (error instanceof SessionStateError) {
    return {
      blockedByLogin: true,
      failureType: mapSessionFailureType(error.sessionState),
      message: error.message
    } satisfies {
      blockedByLogin: boolean;
      failureType: FailureType;
      message: string;
    };
  }

  const rawMessage = error instanceof Error ? error.message : "\u767b\u5f55\u6062\u590d\u68c0\u67e5\u5931\u8d25\u3002";

  if (isBrowserProfileConflictError(rawMessage)) {
    return {
      blockedByLogin: false,
      failureType: "network_or_page_error",
      message: `这个账号的 Edge 登录窗口还开着，请先手动关闭该窗口，等 2 到 3 秒让登录态落盘后再点“验证”。为避免刚登录的会话丢失，系统不会再强制关闭浏览器。原始错误：${rawMessage}`
    } satisfies {
      blockedByLogin: boolean;
      failureType: FailureType;
      message: string;
    };
  }

  if (isBrowserLaunchError(rawMessage)) {
    return {
      blockedByLogin: false,
      failureType: "network_or_page_error",
      message: `\u6062\u590d\u68c0\u67e5\u65f6\u6d4f\u89c8\u5668\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\uff1b\u5982\u679c\u4ecd\u7136\u5931\u8d25\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u624b\u52a8\u767b\u5f55\u7a97\u53e3\u3002\u539f\u59cb\u9519\u8bef\uff1a${rawMessage}`
    } satisfies {
      blockedByLogin: boolean;
      failureType: FailureType;
      message: string;
    };
  }

  return {
    blockedByLogin: false,
    failureType: "unknown_failure",
    message: rawMessage
  } satisfies {
    blockedByLogin: boolean;
    failureType: FailureType;
    message: string;
  };
}

function isBrowserProfileConflictError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("profile") &&
      (normalized.includes("occupied") || normalized.includes("占用")) ||
    normalized.includes("launchpersistentcontext") &&
      (normalized.includes("target page, context or browser has been closed") ||
        normalized.includes("user-data-dir") ||
        normalized.includes("user data directory") ||
        normalized.includes("browser logs"))
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

function isBrowserLaunchError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("launchpersistentcontext") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("executable doesn't exist") ||
    normalized.includes("failed to launch")
  );
}

function sanitizeNavigationUrl(value: string | null | undefined) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  if (/^(about|chrome|edge):/i.test(trimmed)) {
    return null;
  }

  if (trimmed.includes("about:blank")) {
    return null;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function parseOptionalAccountIdFromQuery(requestLike: { query?: unknown }) {
  const query = (requestLike.query ?? {}) as { accountId?: unknown };
  const rawValue = Array.isArray(query.accountId) ? query.accountId[0] : query.accountId;
  const value = typeof rawValue === "string" ? Number(rawValue) : typeof rawValue === "number" ? rawValue : NaN;

  return Number.isInteger(value) && value > 0 ? value : undefined;
}

async function requireAccountById(rawAccountId: string) {
  const accountId = Number(rawAccountId);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    const error = new Error("Account ID is invalid.") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }

  const account = await accountRepository.getAccount(accountId);
  if (!account) {
    const error = new Error("Account does not exist.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  return account;
}
