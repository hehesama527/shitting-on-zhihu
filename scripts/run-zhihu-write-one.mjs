// 只写一篇知乎草稿。不跑 worker tick，不发布。
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
  throw new Error("usage: node scripts/run-zhihu-write-one.mjs <candidateId>");
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
if (!["new", "processing"].includes(String(target.status)) || !["unchecked", "valid"].includes(String(target.validity_status))) {
  throw new Error(`candidate ${CANDIDATE_ID} is not writable: status=${target.status} validity=${target.validity_status}`);
}

const [held] = await pool.query(
  `SELECT id, status, duplication_fingerprint_text
   FROM topic_candidates
   WHERE account_id = ?
     AND id <> ?
     AND status IN ('new', 'processing')
     AND validity_status IN ('unchecked', 'valid')`,
  [ACCOUNT_ID, CANDIDATE_ID]
);
const heldRows = Array.isArray(held) ? held : [];
if (heldRows.length) {
  await pool.query(
    `UPDATE topic_candidates
     SET status = 'blocked'
     WHERE id IN (?)`,
    [heldRows.map((row) => Number(row.id))]
  );
  console.log("held aside candidates", heldRows.map((row) => Number(row.id)));
}

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

try {
  const account = await accountRepository.getAccount(ACCOUNT_ID);
  if (!account) {
    throw new Error(`Account ${ACCOUNT_ID} not found`);
  }
  const soul = await accountSoulService.ensureSoulDocument(account);
  console.log("writing candidate", CANDIDATE_ID, "account", account.name);

  const prepared = await topicPipelineService.prepareNextPublishableDraft({
    publishJobId: null,
    accountContext: {
      accountId: account.id,
      accountName: account.name,
      zhihuUserName: account.zhihuUserName
    },
    accountSoulMarkdown: soul.markdown,
    onStage: async (stage) => {
      console.log("stage", stage, new Date().toISOString());
    }
  });

  console.log("prepare result kind", prepared?.kind ?? null);

  const outDir = path.resolve(".runlogs");
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `draft-${CANDIDATE_ID}.md`);

  if (prepared?.kind === "ready") {
    const body = [
      `# ${prepared.title}`,
      "",
      `topicCardId: ${prepared.topicCardId}`,
      `reviewId: ${prepared.reviewId}`,
      `questionUrl: ${prepared.questionUrl ?? ""}`,
      `writerModel: ${writerRuntime.model}`,
      "",
      prepared.approvedContent
    ].join("\n");
    await fs.writeFile(outPath, body, "utf8");
    console.log("wrote", outPath, "chars", prepared.approvedContent.length);
  } else {
    const dumped = await dumpLatestDraft(pool, CANDIDATE_ID, target.question_title, target.question_url, writerRuntime.model);
    await fs.writeFile(outPath, dumped || `${prepared ? JSON.stringify(prepared, null, 2) : "没有产出草稿。"}\n`, "utf8");
    console.log("wrote fallback", outPath, prepared ?? "null");
  }
} finally {
  for (const row of heldRows) {
    await pool.query(
      `UPDATE topic_candidates
       SET status = ?, duplication_fingerprint_text = ?
       WHERE id = ?`,
      [row.status, row.duplication_fingerprint_text, row.id]
    );
  }
  if (heldRows.length) {
    console.log("restored candidates", heldRows.map((row) => Number(row.id)));
  }
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
