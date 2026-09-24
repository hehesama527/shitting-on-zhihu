import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRepository,
  BrowserSkillService,
  FeishuNotificationService,
  FailureResolutionService,
  HumanizerService,
  JobRepository,
  LlmService,
  OpsDiagnosisService,
  OpsIncidentRepository,
  OpsIncidentService,
  PlaywrightToolRuntime,
  PromptRepository,
  PublishService,
  ReviewService,
  ScheduleRepository,
  ScheduleService,
  SessionService,
  TopicBatchPlannerService,
  TopicDiscoveryService,
  TopicPipelineService,
  TopicRepository,
  TopicReviewService,
  VideoAgentService,
  VideoRepository,
  VideoService,
  VideoWorkerRunner,
  WorkerRunner,
  LayaService,
  applySchemaMigrations,
  getAppConfig,
  getMysqlPool
} from "@zhihu-mvp/core";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LOG_DIR = path.join(ROOT_DIR, ".runlogs");

// 每次 tick 检查：周六 12:00-12:59 且本周尚未清理过
let lastLogClearWeek = -1;

function tryRotateLogs() {
  const now = new Date();
  // 0=日 1=一 ... 6=六
  if (now.getDay() !== 6 || now.getHours() !== 12) {
    return;
  }
  // 用 ISO week number 去重，防止一小时内多次 tick 重复清
  const week = getISOWeek(now);
  if (week === lastLogClearWeek) {
    return;
  }
  lastLogClearWeek = week;

  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log"));
    for (const file of files) {
      fs.writeFileSync(path.join(LOG_DIR, file), "");
    }
    console.log(`[worker] log rotation: cleared ${files.length} log file(s) in ${LOG_DIR}`);
  } catch (err) {
    console.error("[worker] log rotation failed", err);
  }
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

const pool = getMysqlPool();
await applySchemaMigrations(pool);

const promptRepository = new PromptRepository(pool);
const llmService = new LlmService(promptRepository);
const accountRepository = new AccountRepository(pool);
const scheduleRepository = new ScheduleRepository(pool);
const scheduleService = new ScheduleService(scheduleRepository, accountRepository);
const topicRepository = new TopicRepository(pool);
const topicBatchPlannerService = new TopicBatchPlannerService(llmService, topicRepository);
const topicReviewService = new TopicReviewService(llmService);
const reviewService = new ReviewService(llmService);
const jobRepository = new JobRepository(pool);
const humanizerService = new HumanizerService(jobRepository);
const opsIncidentRepository = new OpsIncidentRepository(pool);
const opsDiagnosisService = new OpsDiagnosisService();
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
const layaService = new LayaService();
const sessionService = new SessionService(browserSkillService, llmService, layaService);
const topicDiscoveryService = new TopicDiscoveryService(topicRepository, browserSkillService, sessionService, llmService, layaService);
const publishService = new PublishService(llmService, browserSkillService, sessionService, layaService);
const feishuNotificationService = new FeishuNotificationService();
const videoRepository = new VideoRepository(pool);
const videoAgentService = new VideoAgentService(llmService);
const videoService = new VideoService(videoRepository, videoAgentService, feishuNotificationService);
const videoWorkerRunner = new VideoWorkerRunner(videoRepository, videoService, videoAgentService);
const failureResolutionService = new FailureResolutionService(llmService, layaService);
const opsIncidentService = new OpsIncidentService(
  opsIncidentRepository,
  opsDiagnosisService,
  feishuNotificationService
);
const runner = new WorkerRunner(
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

console.log("[worker] Laya status", JSON.stringify({
  enabled: getAppConfig().layaEnabled,
  endpoint: getAppConfig().layaApiUrl,
  healthy: await layaService.isHealthy()
}));

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function boot() {
  await accountRepository.ensureDefaultAccount();
  await accountRepository.normalizeProfileDirs();

  const loop = async () => {
    if (stopped) {
      return;
    }

    try {
      tryRotateLogs();
      const summary = await runner.tick();
      const videoSummary = await videoWorkerRunner.tick();
      console.log("[worker] tick", JSON.stringify({ ...summary, videoSummary }));
    } catch (error) {
      console.error("[worker] tick failed", error);
      try {
        await opsIncidentService.reportIncident({
          source: "worker_runtime",
          severity: "critical",
          serviceName: "zhihu-worker",
          failureType: "worker_tick_failed",
          title: "Worker tick failed",
          currentStage: "worker_loop",
          rawErrorExcerpt: error instanceof Error ? error.message : String(error),
          evidence: {
            stack: error instanceof Error ? error.stack ?? null : null
          }
        });
      } catch (reportError) {
        console.error("[worker] failed to report ops incident", reportError);
      }
    } finally {
      if (!stopped) {
        timer = setTimeout(loop, getAppConfig().workerIntervalMs);
      }
    }
  };

  await loop();
}

async function shutdown() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
  }
  await runner.closeAllSessions();
  await pool.end();
}

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

await boot();
