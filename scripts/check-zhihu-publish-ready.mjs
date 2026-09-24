import { getMysqlPool, parseMysqlUrl } from "../packages/core/dist/core/src/index.js";

const t = parseMysqlUrl();
if (!["127.0.0.1", "localhost"].includes(t.host) || t.port !== 6306) {
  throw new Error(`refusing non-local mysql ${t.host}:${t.port}`);
}
const pool = getMysqlPool();
const [accounts] = await pool.query(
  `SELECT id, name, zhihu_user_name, status, status_reason, profile_dir FROM accounts WHERE id = 1`
);
const [jobs] = await pool.query(
  `SELECT id, account_id, status, scheduled_at, title, topic_card_id, review_id, final_url
   FROM publish_jobs
   WHERE status IN ('queued','review_passed','login_checking','publishing','publish_verify','retry_waiting','manual_login_required','needs_manual_review')
   ORDER BY id DESC
   LIMIT 30`
);
const [draft] = await pool.query(
  `SELECT tc.id AS topic_card_id, cand.id AS candidate_id, cand.status AS candidate_status, cand.question_title, cand.question_url,
          d.id AS draft_id, d.draft_type, CHAR_LENGTH(d.content) AS chars, r.id AS review_id, r.review_status,
          CHAR_LENGTH(r.approved_content) AS approved_chars
   FROM topic_candidates cand
   JOIN topic_cards tc ON tc.topic_candidate_id = cand.id
   JOIN drafts d ON d.topic_card_id = tc.id
   LEFT JOIN reviews r ON r.draft_id = d.id
   WHERE cand.id = 257
   ORDER BY d.id DESC
   LIMIT 6`
);
console.log(JSON.stringify({ accounts, jobs, draft }, null, 2));
await pool.end();
