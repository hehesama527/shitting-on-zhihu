import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

const pool = getMysqlPool();
await pool.execute(
  `UPDATE publish_jobs 
   SET status = 'pending', 
       current_stage = 'pending', 
       last_error_type = NULL, 
       retry_count = 0, 
       resume_anchor_json = NULL, 
       updated_at = NOW() 
   WHERE id = 459`
);

const [rows] = await pool.execute("SELECT id, status, current_stage, retry_count FROM publish_jobs WHERE id = 459");
console.log("Reset Job 459 result:", rows);
await pool.end();
