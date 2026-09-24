import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();

const [jobs] = await pool.execute(`
  SELECT 
    pj.id,
    pj.account_id,
    a.name AS account_name,
    tcan.question_title,
    tcan.question_url,
    pj.status,
    pj.current_stage,
    pj.last_error_type,
    pj.retry_count,
    pj.created_at,
    pj.updated_at
  FROM publish_jobs pj
  LEFT JOIN accounts a ON a.id = pj.account_id
  LEFT JOIN topic_cards tc ON tc.id = pj.topic_card_id
  LEFT JOIN topic_candidates tcan ON tcan.id = tc.topic_candidate_id
  WHERE pj.status NOT IN ('published')
  ORDER BY pj.id DESC
  LIMIT 50
`);

console.log(`Found ${jobs.length} non-published jobs:\n`);
for (const j of jobs) {
  console.log(`--------------------------------------------------`);
  console.log(`Job #${j.id} | Account #${j.account_id} (${j.account_name ?? "未知"}) | Status: ${j.status} | Stage: ${j.current_stage}`);
  console.log(`  Question: ${j.question_title ?? "无标题"}`);
  console.log(`  URL: ${j.question_url ?? "无URL"}`);
  console.log(`  Error Type: ${j.last_error_type ?? "无"} | Retries: ${j.retry_count}`);
  console.log(`  Updated: ${j.updated_at}`);
}

await pool.end();
