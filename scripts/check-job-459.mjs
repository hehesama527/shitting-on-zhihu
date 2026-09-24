import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();

const [job] = await pool.execute(`
  SELECT id, account_id, status, current_stage, last_error_type, retry_count, final_url, updated_at
  FROM publish_jobs WHERE id = 459
`);
console.log("Job 459:", job);

const [attempts] = await pool.execute(`
  SELECT *
  FROM publish_attempts WHERE publish_job_id = 459 ORDER BY id DESC LIMIT 5
`);
console.log("\nAttempts:", attempts);

const [traces] = await pool.execute(`
  SELECT id, stage, action, input_json, result_json, error_message, created_at
  FROM tool_traces WHERE publish_job_id = 459 ORDER BY id DESC LIMIT 15
`);
console.log("\nRecent Traces:");
for (const t of traces.reverse()) {
  console.log(`Trace #${t.id} [${t.stage}] ${t.action} (${t.created_at})`);
  console.log(`  input: ${t.input_json?.slice(0, 120)}`);
  if (t.result_json) console.log(`  result: ${t.result_json?.slice(0, 120)}`);
  if (t.error_message) console.log(`  err: ${t.error_message?.slice(0, 120)}`);
}

await pool.end();
