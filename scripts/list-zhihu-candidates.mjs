import { getMysqlPool, parseMysqlUrl } from "../packages/core/dist/core/src/index.js";

const t = parseMysqlUrl();
if (!["127.0.0.1", "localhost"].includes(t.host) || t.port !== 6306) {
  throw new Error(`refusing non-local mysql ${t.host}:${t.port}`);
}
const pool = getMysqlPool();
const [rows] = await pool.query(
  `SELECT id, status, validity_status, priority, fit_score, question_title
   FROM topic_candidates
   WHERE account_id = 1
   ORDER BY
     CASE status WHEN 'new' THEN 1 WHEN 'processing' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
     CASE priority WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 WHEN 'P2' THEN 3 ELSE 9 END,
     COALESCE(fit_score, 0) DESC,
     id ASC`
);
console.log(JSON.stringify(rows, null, 2));
await pool.end();
