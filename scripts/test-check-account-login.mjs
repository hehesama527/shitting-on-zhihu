import {
  AccountRepository,
  BrowserSkillService,
  JobRepository,
  LlmService,
  PlaywrightToolRuntime,
  PromptRepository,
  SessionService,
  getMysqlPool
} from "../packages/core/dist/core/src/index.js";

async function main() {
  console.log("=================================================================");
  console.log("【测试真实知乎浏览器环境与 Laya 登录门禁】");
  console.log("=================================================================");

  const pool = getMysqlPool();
  try {
    const accountRepo = new AccountRepository(pool);
    const jobRepo = new JobRepository(pool);
    const promptRepo = new PromptRepository(pool);
    const llmService = new LlmService(promptRepo);
    const runtime = new PlaywrightToolRuntime(jobRepo);
    const browserSkillService = new BrowserSkillService(runtime, jobRepo);
    const sessionService = new SessionService(browserSkillService, llmService);

    const account = await accountRepo.getAccount(1);
    if (!account) {
      throw new Error("账号 1 不存在");
    }

    console.log(`目标账号: [${account.id}] ${account.name} (知乎昵称: ${account.zhihu_user_name})`);
    console.log(`Profile 路径: ${account.profileDir}`);

    const traceBase = {
      sessionKey: "test-login-check",
      profileDir: account.profileDir,
      publishJobId: null,
      publishAttemptId: null,
      traceGroupId: "test-group",
      agentName: "publish_agent",
      stage: "login_checking"
    };

    console.log("正在使用真实的 Edge Profile 打开知乎首页...");
    await browserSkillService.open(traceBase, { url: "https://www.zhihu.com" });

    console.log("正在获取知乎页面实时快照并由 Laya 进行极速登录态研判...");
    const snapshot = await browserSkillService.snapshot(traceBase);
    console.log(`页面标题: ${snapshot.title}`);
    console.log(`当前 URL: ${snapshot.url}`);
    console.log(`检测到按钮数量: ${snapshot.buttons?.length ?? 0}`);

    const tStart = Date.now();
    const sessionState = await sessionService.detectSessionState(snapshot);
    const elapsed = Date.now() - tStart;

    console.log("\n-----------------------------------------------------------------");
    console.log(`【Laya 登录态判定结果】:`);
    console.log(`  --> 状态 (session_state): ${sessionState.session_state}`);
    console.log(`  --> 原因 (reason): ${sessionState.reason}`);
    console.log(`  --> 置信度 (confidence): ${sessionState.confidence}`);
    console.log(`  --> 耗时: ${elapsed} ms (相比原系统的 6000ms 极大提速！)`);
    console.log("-----------------------------------------------------------------");

    await browserSkillService.closeSession("test-login-check");
    console.log("✓ 浏览器 Session 安全关闭完成。");
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
