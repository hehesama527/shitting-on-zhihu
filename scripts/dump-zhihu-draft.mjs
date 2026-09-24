import fs from "node:fs/promises";
import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const CANDIDATE_ID = Number(process.argv[2] ?? 258);
const pool = getMysqlPool();

try {
  const [drafts] = await pool.query(
    `SELECT d.id, d.draft_type, d.content, d.created_at
     FROM drafts d
     JOIN topic_cards tc ON tc.id = d.topic_card_id
     WHERE tc.topic_candidate_id = ?
     ORDER BY d.id DESC
     LIMIT 12`,
    [CANDIDATE_ID]
  );

  const rows = Array.isArray(drafts) ? drafts : [];
  console.log(
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        type: row.draft_type,
        created: row.created_at,
        chars: String(row.content ?? "").length
      })),
      null,
      2
    )
  );

  const pick =
    rows.find((row) => row.draft_type === "humanized" && row.content) ??
    rows.find((row) => row.draft_type === "raw" && row.content);

  if (!pick) {
    throw new Error(`no draft for candidate ${CANDIDATE_ID}`);
  }

  const content = String(pick.content ?? "");
  const meta = {
    candidateId: CANDIDATE_ID,
    draftId: pick.id,
    draftType: pick.draft_type,
    chars: content.length,
    hasDududuCloud: /dududu\.cloud/i.test(content),
    hasGithubRouterList: /github\.com\/hehesama527\/router-list/i.test(content),
    hasDudu: /Dudu|中转站/.test(content),
    hasBoldRouter: /\*\*.*router-list.*\*\*/is.test(content),
    hasBoldFeeLabel: /\*\*对照费率和接入步骤：\*\*/.test(content),
    hasCankaowenxian: /参考文献/.test(content)
  };

  const body = [
    "# claude不允许接入第三方模型了，你们都是怎么应对的呢？",
    "",
    `candidateId: ${CANDIDATE_ID}`,
    `draftId: ${pick.id}`,
    `draftType: ${pick.draft_type}`,
    "reviewStatus: pending (review 503)",
    "questionUrl: https://www.zhihu.com/question/2045562288841790446",
    "writerModel: doubao-seed-evolving",
    "",
    "## 审核摘要",
    "",
    "审核接口 503，以下是写作+润色后的最新草稿，尚未过审核。",
    "",
    "## 正文",
    "",
    content
  ].join("\n");

  await fs.mkdir(".runlogs", { recursive: true });
  await fs.writeFile(`.runlogs/draft-${CANDIDATE_ID}.md`, body, "utf8");
  console.log(JSON.stringify(meta, null, 2));
} finally {
  await pool.end();
}
