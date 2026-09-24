import fs from "node:fs/promises";
import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();
const [drafts] = await pool.query("SELECT id, draft_type, content, created_at FROM drafts WHERE id = 454");
const [reviews] = await pool.query(
  "SELECT id, draft_id, review_status, review_summary, approved_content, hard_gate_json, editorial_review_json, publish_review_json FROM reviews WHERE id = 200"
);
const draft = drafts[0];
const review = reviews[0];
const editorial = JSON.parse(review.editorial_review_json || "{}");
const publish = JSON.parse(review.publish_review_json || "{}");
const hard = JSON.parse(review.hard_gate_json || "{}");
const content = String(draft.content ?? "");
const meta = {
  candidateId: 254,
  topicCardId: 103,
  draftId: draft.id,
  reviewId: review.id,
  reviewStatus: review.review_status,
  reviewSummary: review.review_summary,
  editorialDecision: editorial.decision,
  editorialIssues: editorial.issues,
  editorialRewriteBrief: editorial.rewrite_brief,
  editorialScore: editorial.score,
  publishDecision: publish.decision,
  publishIssues: publish.issues,
  hasDududuCloud: /dududu\.cloud/i.test(content),
  hasGithubRouterList: /github\.com\/hehesama527\/router-list/i.test(content),
  hasDudu: /Dudu|中转站/.test(content)
};

const body = [
  "# 个人开发者想保质保量调用Claude/GPT等完整大模型 API，除了走官方，有没有便宜靠谱三方渠道？",
  "",
  "candidateId: 254",
  "topicCardId: 103",
  "draftId: 454 (humanized, latest)",
  "reviewId: 200",
  "reviewStatus: " + review.review_status,
  "questionUrl: https://www.zhihu.com/question/2050710804123727265",
  "",
  "## 审核摘要",
  "",
  review.review_summary || "",
  "",
  "## 正文",
  "",
  content
].join("\n");

await fs.mkdir(".runlogs", { recursive: true });
await fs.writeFile(".runlogs/draft-254.md", body, "utf8");
await fs.writeFile(".runlogs/draft-254-review.json", JSON.stringify({ meta, hard, editorial, publish }, null, 2), "utf8");
console.log(JSON.stringify(meta, null, 2));
await pool.end();
