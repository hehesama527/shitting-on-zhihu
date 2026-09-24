// 只发布选题 257 的现有草稿。不启动 worker 循环、知乎生产后端、运维 agent。
import fs from "node:fs/promises";
import path from "node:path";
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

const ACCOUNT_ID = 1;
const CANDIDATE_ID = 257;
const LIVE_STATUSES = [
  "review_passed",
  "login_checking",
  "publishing",
  "publish_verify",
  "retry_waiting",
  "manual_login_required"
];

const mysqlTarget = parseMysqlUrl();
if (!["127.0.0.1", "localhost"].includes(mysqlTarget.host) || mysqlTarget.port !== 6306) {
  throw new Error(`refusing non-local mysql ${mysqlTarget.host}:${mysqlTarget.port}/${mysqlTarget.database}`);
}
console.log(`mysql ${mysqlTarget.host}:${mysqlTarget.port}/${mysqlTarget.database}`);

const pool = getMysqlPool();
await applySchemaMigrations(pool);

const [liveJobs] = await pool.query(
  `SELECT id, account_id, status, scheduled_at, title
   FROM publish_jobs
   WHERE status IN (?)
   ORDER BY id DESC`,
  [LIVE_STATUSES]
);
if (Array.isArray(liveJobs) && liveJobs.length > 0) {
  throw new Error(`refusing to publish while live jobs exist: ${JSON.stringify(liveJobs)}`);
}

const [rows] = await pool.query(
  `SELECT
     cand.id AS candidate_id,
     cand.status AS candidate_status,
     cand.question_title,
     cand.question_url,
     tc.id AS topic_card_id,
     d.id AS draft_id,
     d.content AS humanized_content,
     r.id AS review_id,
     r.review_status
   FROM topic_candidates cand
   JOIN topic_cards tc ON tc.topic_candidate_id = cand.id
   JOIN drafts d ON d.topic_card_id = tc.id AND d.draft_type = 'humanized'
   JOIN reviews r ON r.draft_id = d.id
   WHERE cand.id = ?
   ORDER BY d.id DESC
   LIMIT 1`,
  [CANDIDATE_ID]
);
const draft = rows?.[0];
if (!draft?.humanized_content || !draft.review_id || !draft.topic_card_id) {
  throw new Error(`candidate ${CANDIDATE_ID} has no humanized draft/review`);
}
console.log(
  JSON.stringify(
    {
      candidateId: draft.candidate_id,
      candidateStatus: draft.candidate_status,
      topicCardId: draft.topic_card_id,
      draftId: draft.draft_id,
      reviewId: draft.review_id,
      reviewStatus: draft.review_status,
      chars: String(draft.humanized_content).length,
      questionUrl: draft.question_url
    },
    null,
    2
  )
);

await pool.query(
  `UPDATE reviews
   SET review_status = 'pass',
       approved_content = ?,
       review_summary = CONCAT(COALESCE(review_summary, ''), '\n[manual publish override] 用户确认发布最新 humanized 稿')
   WHERE id = ?`,
  [draft.humanized_content, draft.review_id]
);
await pool.query(
  `UPDATE topic_candidates
   SET status = 'accepted'
   WHERE id = ?`,
  [CANDIDATE_ID]
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

const account = await accountRepository.getAccount(ACCOUNT_ID);
if (!account?.profileDir) {
  throw new Error(`account ${ACCOUNT_ID} missing profileDir`);
}

const promptSnapshot = await llmService.getPromptSnapshotForAccount({
  writerPromptVersionId: account.writerPromptVersionId
});
const jobId = await jobRepository.createQueuedJob({
  accountId: ACCOUNT_ID,
  scheduledAt: new Date(),
  title: draft.question_title,
  promptVersionSnapshotJson: JSON.stringify(promptSnapshot)
});
await jobRepository.replaceJobPayload(jobId, {
  topicCardId: Number(draft.topic_card_id),
  reviewId: Number(draft.review_id),
  title: String(draft.question_title),
  promptVersionSnapshotJson: JSON.stringify(promptSnapshot)
});
await jobRepository.updateScheduledAt(jobId, new Date());
console.log("created review_passed job", jobId);
console.log("running runJobNow, no harvest, no worker loop");

try {
  const result = await runner.runJobNow(jobId);
  const outDir = path.resolve(".runlogs");
  await fs.mkdir(outDir, { recursive: true });
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
  await fs.writeFile(path.join(outDir, "publish-257.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log("publish result", JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
