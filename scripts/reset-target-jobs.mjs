import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const pool = getMysqlPool();
  const targetJobIds = [466, 459, 450];

  for (const id of targetJobIds) {
    await pool.execute(
      `UPDATE publish_jobs 
       SET status = 'review_passed', 
           current_stage = 'login_checking', 
           last_error_type = NULL, 
           retry_count = 0, 
           resume_anchor_json = NULL, 
           updated_at = NOW() 
       WHERE id = ?`,
      [id]
    );
  }

  const [rows] = await pool.execute(
    `SELECT id, account_id, status, current_stage, retry_count, updated_at 
     FROM publish_jobs 
     WHERE id IN (466, 459, 450)`
  );
  console.log("Reset target jobs result:");
  for (const r of rows) {
    console.log(`Job #${r.id} | Account #${r.account_id} | Status: ${r.status} | Stage: ${r.current_stage} | Retries: ${r.retry_count}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Reset error:", err);
  process.exit(1);
});
