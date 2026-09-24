import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const pool = getMysqlPool();
  const [jobs] = await pool.execute(`
    SELECT 
      pj.id, 
      pj.account_id, 
      pj.status, 
      pj.current_stage, 
      pj.scheduled_at, 
      pj.created_at,
      dps.scheduled_at AS slot_scheduled_at,
      COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) AS effective_scheduled_at,
      NOW() AS db_now
    FROM publish_jobs pj
    LEFT JOIN daily_publish_schedule dps ON dps.publish_job_id = pj.id
    WHERE pj.id IN (450, 459, 466)
  `);
  console.log("Job schedule check:", JSON.stringify(jobs, null, 2));

  // Check which account is blocked
  const [accounts] = await pool.execute(`
    SELECT id, name, status, status_reason, cooldown_until, last_risk_at FROM accounts
  `);
  console.log("\nAccounts:", accounts);

  await pool.end();
}

main().catch(console.error);
