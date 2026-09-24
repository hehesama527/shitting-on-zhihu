import {
  AccountRepository,
  BrowserSkillService,
  FailureResolutionService,
  FeishuNotificationService,
  HumanizerService,
  JobRepository,
  LlmService,
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
  WorkerRunner,
  applySchemaMigrations,
  getMysqlPool,
  parseMysqlUrl
} from "../packages/core/dist/core/src/index.js";

const JOB_ID = Number(process.argv[2] ?? 141);
const mysqlTarget = parseMysqlUrl();
if (!["127.0.0.1", "localhost"].includes(mysqlTarget.host) || mysqlTarget.port !== 6306) {
  throw new Error(`refusing non-local mysql ${mysqlTarget.host}:${mysqlTarget.port}/${mysqlTarget.database}`);
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
const failureResolutionService = new FailureResolutionService(llmService);
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
  feishuNotificationService
);

await jobRepository.retryJob(JOB_ID);
console.log("retrying job", JOB_ID);
const result = await runner.runJobNow(JOB_ID);
console.log(
  "publish result",
  JSON.stringify(
    {
      jobId: JOB_ID,
      processed: result.processed,
      blockedByLogin: result.blockedByLogin,
      message: result.message,
      status: result.job?.status ?? null,
      finalUrl: result.job?.finalUrl ?? null,
      failureReason: result.job?.failureReason ?? null
    },
    null,
    2
  )
);
await pool.end();
