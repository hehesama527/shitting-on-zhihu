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
  LayaService,
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
  getMysqlPool
} from "../packages/core/dist/core/src/index.js";

const ACCOUNT_ID = 1;

async function main() {
  console.log("=================================================================");
  console.log("【知乎矩阵真实全流程发布实测 (接入 Laya 决策加速层)】");
  console.log("=================================================================");

  const pool = getMysqlPool();
  await applySchemaMigrations(pool);

  try {
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
    
    // 初始化 Laya 服务并注入
    const layaService = new LayaService();
    const layaHealthy = await layaService.isHealthy();
    console.log(`✓ Laya 决策加速层状态: ${layaHealthy ? "已连接并处于 GPU 就绪态 (OK)" : "未连接 (将使用 LLM 兜底)"}`);

    const sessionService = new SessionService(browserSkillService, llmService, layaService);
    const publishService = new PublishService(llmService, browserSkillService, sessionService, layaService);
    const topicDiscoveryService = new TopicDiscoveryService(topicRepository, browserSkillService, sessionService, llmService);
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
      throw new Error(`账号 ${ACCOUNT_ID} 缺少 profileDir 配置`);
    }

    console.log(`执行账号: [${account.id}] ${account.name} (知乎: ${account.zhihu_user_name})`);

    // 检查是否有由于故障卡住的旧任务
    const [liveJobs] = await pool.query(
      `SELECT id, status, title FROM publish_jobs WHERE status IN ('publishing', 'login_checking', 'publish_verify')`
    );
    if (Array.isArray(liveJobs) && liveJobs.length > 0) {
      console.log("检测到卡住的运行中旧任务，先将其重置为 needs_manual_review:", liveJobs);
      for (const j of liveJobs) {
        await jobRepository.updateJobStatus(j.id, "needs_manual_review", {
          failureReason: "测试前自动清理未结束的旧任务状态"
        });
      }
    }

    // 创建一个新的排队任务
    const promptSnapshot = await llmService.getPromptSnapshotForAccount({
      writerPromptVersionId: account.writerPromptVersionId
    });

    const now = new Date();
    const jobId = await jobRepository.createQueuedJob({
      accountId: ACCOUNT_ID,
      scheduledAt: now,
      title: null,
      promptVersionSnapshotJson: JSON.stringify(promptSnapshot)
    });

    console.log(`\n[+] 成功创建待执行发布任务 ID: ${jobId}`);
    console.log(`[*] 启动全流程 Worker 驱动 (选题 -> 写作 -> 去AI味 -> 审核 -> 登录核验 -> 页面发布 -> 结果核验)...`);

    const roundStart = Date.now();
    const result = await runner.runJobNow(jobId);
    const totalCost = ((Date.now() - roundStart) / 1000).toFixed(1);

    console.log("\n=================================================================");
    console.log(`【发布结果报告】 (总耗时: ${totalCost} 秒)`);
    console.log("=================================================================");
    console.log(`任务 ID: ${jobId}`);
    console.log(`阶段状态: ${result.job?.status}`);
    console.log(`当前所处步骤: ${result.job?.currentStage}`);
    console.log(`文章标题: ${result.job?.title}`);
    console.log(`最终知乎链接: ${result.job?.finalUrl}`);
    console.log(`失败/阻断原因: ${result.job?.failureReason ?? "无（成功）"}`);

    if (result.job?.status === "published") {
      console.log(`\n🎉 恭喜！全流程一轮真实发布 100% 成功闭环！`);
      console.log(`知乎线上地址: ${result.job?.finalUrl}`);
    } else {
      console.log(`\n⚠️ 任务当前停留在: ${result.job?.status}，详细信息参见上方输出。`);
    }

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("执行过程异常:", err);
  process.exit(1);
});
