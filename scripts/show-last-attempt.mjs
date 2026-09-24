import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const pool = getMysqlPool();
  const [rows] = await pool.execute(
    "SELECT id, publish_job_id, attempt_no, status, failure_type, failure_reason, current_url, created_at FROM publish_attempts ORDER BY id DESC LIMIT 4"
  );
  for (const r of rows) {
    console.log(`\nAttempt #${r.id} (Job #${r.publish_job_id}, attempt_no ${r.attempt_no}): status=${r.status}, fail=${r.failure_type}`);
    console.log(`Reason: ${r.failure_reason}`);
    console.log(`URL: ${r.current_url}`);
  }
  const [jobs] = await pool.execute(
    "SELECT id, account_id, status, current_stage, last_error_type, retry_count FROM publish_jobs WHERE id IN (450, 459, 466)"
  );
  console.log("\nJobs:", jobs);
  await pool.end();
}

main().catch(console.error);
