import { getMysqlPool } from "../packages/core/dist/core/src/index.js";
import { execSync } from "node:child_process";

async function main() {
  const pool = getMysqlPool();

  console.log("=== Publish Jobs Status ===");
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
    WHERE pj.id IN (450, 459, 466) OR pj.status NOT IN ('pending', 'published', 'failed_terminal')
    ORDER BY pj.id DESC
  `);

  for (const j of jobs) {
    console.log(`Job #${j.id} | Account #${j.account_id} (${j.account_name ?? "未知"}) | Status: ${j.status} | Stage: ${j.current_stage} | Err: ${j.last_error_type} | Updated: ${j.updated_at}`);
  }

  console.log("\n=== Latest 5 Attempts ===");
  const [attempts] = await pool.execute(`
    SELECT id, publish_job_id, attempt_no, status, failure_type, failure_reason, current_url, created_at
    FROM publish_attempts
    ORDER BY id DESC
    LIMIT 5
  `);

  for (const a of attempts) {
    console.log(`\nAttempt #${a.id} (Job #${a.publish_job_id}, #${a.attempt_no}) | Status: ${a.status} | Fail: ${a.failure_type}`);
    console.log(`  Reason: ${a.failure_reason}`);
    console.log(`  URL: ${a.current_url}`);
  }

  // Test Laya service
  console.log("\n=== Laya Service Test ===");
  try {
    const resp = await fetch("http://127.0.0.1:8105/health");
    console.log("Laya /health status:", resp.status, await resp.json());
  } catch (e) {
    console.log("Laya /health error:", e.message);
  }

  console.log("\n=== Chrome Processes ===");
  try {
    const psOut = execSync("ps -eo pid,ppid,%cpu,%mem,cmd | grep -E 'chrome|msedge' | grep -v grep").toString();
    console.log(psOut.trim() || "(No Chrome/Edge processes)");
  } catch {
    console.log("(No Chrome/Edge processes)");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Main error:", err);
  process.exit(1);
});
