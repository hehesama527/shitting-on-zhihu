// 安全测试脚本：只跑一次 WorkerRunner.tick()，用来验证选题/写作/审核 prompt 效果，
// 不会进入循环，跑完立刻退出。
//
// 用途：dudu 中转站选题小范围试点——在不实际发布的前提下，看新 prompt 选出来/写出来的
// 内容质量。
//
// 安全边界（重要，运行前必须确认）：
//   1. 运行前必须确认数据库里没有处于 review_passed / login_checking / publishing /
//      publish_verify / retry_waiting / manual_login_required 状态、且 scheduled_at
//      已经过去的"到期任务"——否则这次 tick 的 processDueJobs 会把它们当成到期任务，
//      走真实浏览器登录+发布流程，直接把内容发到真实知乎账号上。
//      查询方法（用 packages/core/dist 里编译产物）：
//        SELECT id, account_id, status, scheduled_at FROM publish_jobs
//        WHERE status IN ('review_passed','login_checking','publishing','publish_verify',
//                          'retry_waiting','manual_login_required')
//      如果有旧任务且不想让它被自动发布，先把它 UPDATE 成 needs_manual_review。
//   2. 这次 tick 会后台启动最多 3 路写稿（每账号只写自己排期里最近的一篇），
//      然后按账号串行采题。某个账号正在写稿或 30 分钟内有临近排期时，只跳过该账号采题，
//      不会堵住其他账号。
//      本脚本在退出前会等待后台写稿结束，避免断开数据库连接。
//      采题会用账号的浏览器 profile 访问知乎抓推荐/邀请（只读，不发布）。
//   3. 这次 tick 跑完之后，如果有任务被 prepare 成功变成 review_passed，它们会一直停留在
//      该状态；如果之后又跑了另一次 tick（无论是再跑这个脚本，还是真正启动了
//      apps/worker），这些 review_passed 任务会被当成到期任务，直接触发真实发布。
//      所以每次用这个脚本测试完，看完结果后，如果不想让它被发布，
//      要主动把新产生的 review_passed 任务改回 needs_manual_review。
//
// 用法（需要先 build shared + core）：
//   npm run build -w @zhihu-mvp/shared && npm run build -w @zhihu-mvp/core
//   node scripts/test-run-one-worker-tick.mjs
import {
  AccountRepository,
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
  BrowserSkillService,
  TopicBatchPlannerService,
  TopicDiscoveryService,
  TopicPipelineService,
  TopicRepository,
  TopicReviewService,
  WorkerRunner,
  applySchemaMigrations,
  getMysqlPool
} from "../packages/core/dist/core/src/index.js";

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
const sessionService = new SessionService(browserSkillService, llmService);
const topicDiscoveryService = new TopicDiscoveryService(topicRepository, browserSkillService, sessionService, llmService);
const publishService = new PublishService(llmService, browserSkillService, sessionService);
const feishuNotificationService = new FeishuNotificationService();
const failureResolutionService = new FailureResolutionService(llmService);
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

console.log("=== running ONE tick only ===");
const summary = await runner.tick();
console.log("=== waiting background prepares ===");
await runner.waitForInFlightPrepares();
console.log("=== tick summary ===");
console.log(JSON.stringify(summary, null, 2));

await runner.closeAllSessions();
await pool.end();
console.log("=== done, exiting (no loop) ===");
