// 按已有选题卡重写一篇知乎草稿。不跑 worker tick，不发布。
import fs from "node:fs/promises";
import path from "node:path";
import {
  AccountRepository,
  AccountSoulService,
  HumanizerService,
  JobRepository,
  LlmService,
  PromptRepository,
  ReviewService,
  TopicBatchPlannerService,
  TopicPipelineService,
  TopicRepository,
  TopicReviewService,
  applySchemaMigrations,
  getMysqlPool,
  parseMysqlUrl,
  readLlmRuntimeConfig
} from "../packages/core/dist/core/src/index.js";

const ACCOUNT_ID = 1;
const CANDIDATE_ID = Number(process.argv[2] ?? 0);
const DANGEROUS_STATUSES = [
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

const writerRuntime = readLlmRuntimeConfig("writer_agent");
const reviewRuntime = readLlmRuntimeConfig("review_agent");
console.log(
  JSON.stringify(
    {
      writer: { model: writerRuntime.model, baseUrl: writerRuntime.baseUrl, wireApi: writerRuntime.wireApi },
      review: { model: reviewRuntime.model, baseUrl: reviewRuntime.baseUrl, wireApi: reviewRuntime.wireApi }
    },
    null,
    2
  )
);

const pool = getMysqlPool();
await applySchemaMigrations(pool);

const [dangerousJobs] = await pool.query(
  `SELECT id, account_id, status, scheduled_at
   FROM publish_jobs
   WHERE status IN (?)
   ORDER BY id DESC
   LIMIT 20`,
  [DANGEROUS_STATUSES]
);
if (Array.isArray(dangerousJobs) && dangerousJobs.length > 0) {
  console.log("found publish jobs in live statuses (this script will not tick/publish):");
  console.log(JSON.stringify(dangerousJobs, null, 2));
} else {
  console.log("no live publish jobs");
}

if (!Number.isInteger(CANDIDATE_ID) || CANDIDATE_ID <= 0) {
  throw new Error("usage: node scripts/run-zhihu-rewrite-one.mjs <candidateId>");
}

const [targetRows] = await pool.query(
  `SELECT id, account_id, status, validity_status, priority, fit_score, question_title, question_url
   FROM topic_candidates
   WHERE id = ?`,
  [CANDIDATE_ID]
);
const target = targetRows?.[0];
if (!target) {
  throw new Error(`candidate ${CANDIDATE_ID} not found`);
}
console.log("target candidate", JSON.stringify(target, null, 2));

const [cardRows] = await pool.query(
  `SELECT id, summary_text
   FROM topic_cards
   WHERE topic_candidate_id = ?
   ORDER BY id DESC
   LIMIT 1`,
  [CANDIDATE_ID]
);
const topicCard = cardRows?.[0];
if (!topicCard) {
  throw new Error(`candidate ${CANDIDATE_ID} has no topic card`);
}
console.log("topicCardId", topicCard.id);

const promptRepository = new PromptRepository(pool);
const llmService = new LlmService(promptRepository);
const accountRepository = new AccountRepository(pool);
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
const accountSoulService = new AccountSoulService();

const revisionFeedback = [
  "上一版已经把问题答完整了，但产品引导不合格，必须按新规则重写。",
  "1) 产品段必须有且仅有一句 **加粗** 引导，点名文末 GitHub 仓库 router-list，并写清打开后看 Claude Code 手动接入或 CC Switch 教程；本题是第三方模型接入，不要只写成对费率。",
  "2) 仓库名 router-list 可以写在正文中间；https 链接不要写进中间段落。",
  "3) 文末参考文献必须单独成段，链接上方加粗说明，格式如下：",
  "**对照费率和接入步骤：**",
  "https://github.com/hehesama527/router-list",
  "4) 不要写点这里注册、充值或获取 Key。",
  "5) 继续保留排查顺序、复合案例、四种应对、算账和回滚清单，不要缩短信息量。"
].join("\n");

try {
  const account = await accountRepository.getAccount(ACCOUNT_ID);
  if (!account) {
    throw new Error(`Account ${ACCOUNT_ID} not found`);
  }
  const soul = await accountSoulService.ensureSoulDocument(account);
  const promptSnapshot = await llmService.getActivePromptSnapshot();
  console.log("rewriting candidate", CANDIDATE_ID, "account", account.name);

  const rewritten = await topicPipelineService.rewriteExistingTopic({
    publishJobId: null,
    topicCardId: Number(topicCard.id),
    candidateTitle: String(target.question_title ?? ""),
    questionUrl: String(target.question_url ?? ""),
    revisionFeedback,
    promptVersionSnapshotJson: JSON.stringify(promptSnapshot),
    accountContext: {
      accountId: account.id,
      accountName: account.name,
      zhihuUserName: account.zhihuUserName
    },
    accountSoulMarkdown: soul.markdown,
    maxAttempts: 1,
    onStage: async (stage) => {
      console.log("stage", stage, new Date().toISOString());
    }
  });

  console.log("rewrite result kind", rewritten?.kind ?? null);
  if (rewritten?.kind && rewritten.kind !== "ready") {
    console.log("rewrite result", JSON.stringify(rewritten, null, 2));
  }

  const outDir = path.resolve(".runlogs");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `draft-${CANDIDATE_ID}.md`);

  if (rewritten?.kind === "ready") {
    const body = [
      `# ${rewritten.title}`,
      "",
      `candidateId: ${CANDIDATE_ID}`,
      `topicCardId: ${rewritten.topicCardId}`,
      `reviewId: ${rewritten.reviewId}`,
      `questionUrl: ${target.question_url ?? ""}`,
      `writerModel: ${writerRuntime.model}`,
      "",
      rewritten.approvedContent
    ].join("\n");
    await fs.writeFile(outPath, body, "utf8");
    console.log("wrote", outPath, "chars", rewritten.approvedContent.length);
  } else {
    const dumped = await dumpLatestDraft(pool, CANDIDATE_ID, target.question_title, target.question_url, writerRuntime.model);
    await fs.writeFile(outPath, dumped || `${rewritten ? JSON.stringify(rewritten, null, 2) : "没有产出草稿。"}\n`, "utf8");
    console.log("wrote fallback", outPath);
  }
} finally {
  await pool.end();
}

async function dumpLatestDraft(db, candidateId, questionTitle, questionUrl, writerModel) {
  const [drafts] = await db.query(
    `SELECT d.id, d.draft_type, d.content, r.id AS review_id, r.review_status, r.review_summary
     FROM drafts d
     JOIN topic_cards tc ON tc.id = d.topic_card_id
     LEFT JOIN reviews r ON r.draft_id = d.id
     WHERE tc.topic_candidate_id = ?
     ORDER BY d.id DESC
     LIMIT 8`,
    [candidateId]
  );
  const humanized = (drafts ?? []).find((row) => row.draft_type === "humanized" && row.content);
  if (!humanized) {
    return "";
  }
  return [
    `# ${questionTitle}`,
    "",
    `candidateId: ${candidateId}`,
    `draftId: ${humanized.id}`,
    `reviewId: ${humanized.review_id ?? ""}`,
    `reviewStatus: ${humanized.review_status ?? ""}`,
    `questionUrl: ${questionUrl ?? ""}`,
    `writerModel: ${writerModel}`,
    "",
    "## 审核摘要",
    "",
    humanized.review_summary || "无",
    "",
    "## 正文",
    "",
    humanized.content
  ].join("\n");
}
