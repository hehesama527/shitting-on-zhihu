import { getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const pool = getMysqlPool();
  const [attempts] = await pool.execute(`
    SELECT id, attempt_no, status, failure_type, failure_reason, current_url, created_at 
    FROM publish_attempts 
    WHERE publish_job_id = 450 
    ORDER BY id DESC 
    LIMIT 2
  `);
  console.log("=== Job 450 Latest Attempts ===");
  for (const a of attempts) {
    console.log(`Attempt #${a.id} (#${a.attempt_no}): status=${a.status}, fail=${a.failure_type}, reason=${a.failure_reason}, url=${a.current_url}`);
  }

  const [traces] = await pool.execute(`
    SELECT id, stage, action, input_json, result_json, error_message, created_at 
    FROM tool_traces 
    WHERE publish_job_id = 450 
    ORDER BY id DESC 
    LIMIT 8
  `);
  console.log("\n=== Job 450 Latest Traces ===");
  for (const t of traces.reverse()) {
    console.log(`Trace #${t.id} [${t.stage}] action=${t.action} err=${t.error_message}`);
    if (t.action === "click") {
      console.log("  result:", t.result_json);
    }
  }

  const [snaps] = await pool.execute(`
    SELECT id, result_json FROM tool_traces 
    WHERE publish_job_id = 450 AND action = 'snapshot' 
    ORDER BY id DESC LIMIT 1
  `);
  if (snaps.length > 0 && snaps[0].result_json) {
    const s = JSON.parse(snaps[0].result_json);
    console.log(`\n=== Latest Snapshot #${snaps[0].id} ===`);
    console.log("URL:", s.url);
    console.log("Buttons:", s.buttons);
    console.log("EditorContent:", s.editorContent);
    console.log("VisibleTexts (first 10):", s.visibleTexts?.slice(0, 10));
  }

  const [jobs] = await pool.execute(`
    SELECT id, status, current_stage, last_error_type, updated_at FROM publish_jobs WHERE id = 450
  `);
  console.log("\nJob 450:", jobs[0]);

  await pool.end();
}

main().catch(console.error);
