import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();

const [jobs] = await pool.execute(`
  SELECT 
    pj.id,
    pj.account_id,
    a.name AS account_name,
    tcan.question_title,
    pj.status,
    pj.current_stage,
    pj.last_error_type,
    pj.retry_count,
    pj.updated_at
  FROM publish_jobs pj
  LEFT JOIN accounts a ON a.id = pj.account_id
  LEFT JOIN topic_cards tc ON tc.id = pj.topic_card_id
  LEFT JOIN topic_candidates tcan ON tcan.id = tc.topic_candidate_id
  ORDER BY pj.id DESC
  LIMIT 5
`);

console.log(`Top 5 Jobs:`);
for (const j of jobs) {
  console.log(`Job #${j.id} | Account #${j.account_id} (${j.account_name ?? "未知"}) | Status: ${j.status} | Stage: ${j.current_stage} | Err: ${j.last_error_type}`);
}

const [attempts] = await pool.execute(`
  SELECT id, publish_job_id, attempt_no, status, failure_type, failure_reason, current_url, created_at
  FROM publish_attempts
  ORDER BY id DESC
  LIMIT 5
`);

console.log(`\nTop 5 Publish Attempts:`);
for (const a of attempts) {
  console.log(`Attempt #${a.id} (Job #${a.publish_job_id}, #${a.attempt_no}) | ${a.status} | Fail: ${a.failure_type} | ${a.failure_reason?.slice(0, 100)}`);
}

const [traces] = await pool.execute(`
  SELECT id, publish_job_id, stage, action, input_json, result_json, error_message, created_at
  FROM tool_traces
  ORDER BY id DESC
  LIMIT 8
`);
console.log(`\nTop 8 Tool Traces:`);
for (const t of traces.reverse()) {
  console.log(`Trace #${t.id} (Job #${t.publish_job_id}) [${t.stage}] ${t.action} err=${t.error_message}`);
  if (t.action === "click") console.log("  click result:", t.result_json);
}

await pool.end();
