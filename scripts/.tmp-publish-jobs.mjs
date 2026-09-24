// 只发布指定任务。不跑 worker 循环、不采题、不启动知乎生产后端和运维 agent。
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

const JOB_IDS = process.argv.slice(2).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
if (JOB_IDS.length === 0) {
  throw new Error("usage: node scripts/.tmp-publish-jobs.mjs <jobId> [jobId...]");
}

const mysqlTarget = parseMysqlUrl();
if (!["127.0.0.1", "localhost"].includes(mysqlTarget.host)) {
  throw new Error(`refusing non-local mysql ${mysqlTarget.host}:${mysqlTarget.port}/${mysqlTarget.database}`);
}
console.log(`mysql ${mysqlTarget.host}:${mysqlTarget.port}/${mysqlTarget.database}`);
console.log(`headless=${process.env.PLAYWRIGHT_HEADLESS ?? ""} jobs=${JOB_IDS.join(",")}`);

const pool = getMysqlPool();
await applySchemaMigrations(pool);

const [targetRows] = await pool.query(
  `SELECT
     pj.id,
     pj.account_id,
     a.name AS account_name,
     a.status AS account_status,
     pj.status,
     pj.current_stage,
     pj.title,
     r.review_status,
     tc.question_url,
     CHAR_LENGTH(COALESCE(d.content, '')) AS chars
   FROM publish_jobs pj
   JOIN accounts a ON a.id = pj.account_id
   LEFT JOIN topic_cards tcard ON tcard.id = pj.topic_card_id
   LEFT JOIN topic_candidates tc ON tc.id = tcard.topic_candidate_id
   LEFT JOIN reviews r ON r.id = pj.review_id
   LEFT JOIN drafts d ON d.topic_card_id = tcard.id AND d.draft_type = 'humanized'
   WHERE pj.id IN (?)
   ORDER BY pj.id`,
  [JOB_IDS]
);

if (!Array.isArray(targetRows) || targetRows.length !== JOB_IDS.length) {
  throw new Error(`expected ${JOB_IDS.length} jobs, found ${Array.isArray(targetRows) ? targetRows.length : 0}`);
}

const questionUrls = new Set();
for (const row of targetRows) {
  if (!["needs_manual_review", "review_passed", "retry_waiting", "failed_terminal"].includes(row.status)) {
    throw new Error(`job ${row.id} status is ${row.status}, refusing to publish`);
  }
  if (row.account_status !== "active") {
    throw new Error(`job ${row.id} account ${row.account_id} is ${row.account_status}`);
  }
  if (row.review_status !== "pass" || Number(row.chars) <= 0 || !row.question_url) {
    throw new Error(`job ${row.id} is missing a pass review / humanized draft / question url`);
  }
  if (questionUrls.has(row.question_url)) {
    throw new Error(`duplicate question url in this batch: ${row.question_url}`);
  }
  questionUrls.add(row.question_url);
}
console.log("targets", JSON.stringify(targetRows, null, 2));

const [liveJobs] = await pool.query(
  `SELECT id, account_id, status, title
   FROM publish_jobs
   WHERE status IN ('review_passed','login_checking','publishing','publish_verify','retry_waiting','manual_login_required')
     AND id NOT IN (?)`,
  [JOB_IDS]
);
if (Array.isArray(liveJobs) && liveJobs.length > 0) {
  throw new Error(`refusing to publish while other live jobs exist: ${JSON.stringify(liveJobs)}`);
}

await pool.query(
  `UPDATE publish_jobs
   SET status = 'review_passed',
       current_stage = 'review_passed',
       failure_reason = NULL,
       last_error_type = NULL,
       retry_count = 0,
       finished_at = NULL
   WHERE id IN (?)
     AND status IN ('needs_manual_review', 'retry_waiting', 'failed_terminal')`,
  [JOB_IDS]
);

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

const results = [];
try {
  for (const jobId of JOB_IDS) {
    console.log(`=== publish job ${jobId} start ${new Date().toISOString()} ===`);
    try {
      const result = await runner.runJobNow(jobId);
      const summary = {
        jobId,
        prepared: result.prepared,
        processed: result.processed,
        blockedByLogin: result.blockedByLogin,
        message: result.message,
        status: result.job?.status ?? null,
        currentStage: result.job?.currentStage ?? null,
        finalUrl: result.job?.finalUrl ?? null,
        failureReason: result.job?.failureReason ?? null
      };
      results.push(summary);
      console.log("publish result", JSON.stringify(summary, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ jobId, error: message });
      console.error(`publish job ${jobId} threw`, error);
    } finally {
      await runner.closeAllSessions();
    }

    const latest = await jobRepository.getJobById(jobId);
    if (latest && latest.status === "review_passed") {
      await jobRepository.updateJobStatus(jobId, "needs_manual_review", {
        currentStage: "needs_manual_review",
        failureReason: latest.failureReason
          ? `${latest.failureReason} | publish-batch freeze`
          : "publish-batch freeze after unsuccessful runJobNow"
      });
      console.log(`job ${jobId} frozen back to needs_manual_review`);
    }
  }
} finally {
  await runner.closeAllSessions();
  await pool.end();
}

console.log("=== batch done ===");
console.log(JSON.stringify(results, null, 2));
