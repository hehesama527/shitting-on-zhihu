// 只采题，不写稿、不发布。给 223 无桌面环境先灌 Dudu 选题池。
// 有可用 valid/unchecked 选题的账号会自动跳过。
import {
  AccountRepository,
  AccountSoulService,
  JobRepository,
  LlmService,
  PlaywrightToolRuntime,
  PromptRepository,
  SessionService,
  BrowserSkillService,
  TopicDiscoveryService,
  TopicRepository,
  applySchemaMigrations,
  getMysqlPool
} from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();
await applySchemaMigrations(pool);

const promptRepository = new PromptRepository(pool);
const llmService = new LlmService(promptRepository);
const accountRepository = new AccountRepository(pool);
const topicRepository = new TopicRepository(pool);
const jobRepository = new JobRepository(pool);
const runtime = new PlaywrightToolRuntime(jobRepository);
const browserSkillService = new BrowserSkillService(runtime, jobRepository);
const sessionService = new SessionService(browserSkillService, llmService);
const topicDiscoveryService = new TopicDiscoveryService(topicRepository, browserSkillService, sessionService, llmService);
const accountSoulService = new AccountSoulService();

const requestedAccountIds = new Set(
  process.argv.slice(2).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
);
const accounts = (await accountRepository.listAccounts()).filter((account) => {
  return requestedAccountIds.size === 0 || requestedAccountIds.has(account.id);
});
console.log(`PLAYWRIGHT_HEADLESS=${process.env.PLAYWRIGHT_HEADLESS ?? ""}`);
console.log(`accounts=${accounts.map((account) => `${account.id}:${account.name}:${account.status}`).join(",")}`);

let harvestedTotal = 0;
for (const account of accounts) {
  if (!account.profileDir) {
    console.log(`[harvest] skip account ${account.id} no profileDir`);
    continue;
  }
  if (account.status !== "active") {
    console.log(`[harvest] skip account ${account.id} status=${account.status}`);
    continue;
  }

  const startedAt = Date.now();
  console.log(`[harvest] start account ${account.id} ${account.name}`);
  try {
    const inheritFromAccountId =
      typeof account.writerPromptSourceAccountId === "number" ? account.writerPromptSourceAccountId : null;
    const ensureSoul = accountSoulService.ensureSoulDocument.bind(accountSoulService);
    const soul = await ensureSoul(account, inheritFromAccountId);
    const harvested = await topicDiscoveryService.harvestCandidates({
      accountId: account.id,
      profileDir: account.profileDir,
      accountContext: {
        accountId: account.id,
        accountName: account.name,
        zhihuUserName: account.zhihuUserName
      },
      accountSoulMarkdown: soul.markdown
    });
    harvestedTotal += harvested;
    console.log(
      JSON.stringify({
        type: "harvest_done",
        accountId: account.id,
        harvested,
        elapsedMs: Date.now() - startedAt
      })
    );
  } catch (error) {
    console.error(`[harvest] account ${account.id} failed`, error);
  }
}

await runtime.closeAllSessions();
await pool.end();
console.log(JSON.stringify({ type: "harvest_summary", harvestedTotal }));
