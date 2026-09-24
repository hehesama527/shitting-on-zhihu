import { PlaywrightToolRuntime, getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const pool = getMysqlPool();
  const [accounts] = await pool.execute("SELECT id, name, zhihu_user_name, status FROM accounts ORDER BY id ASC");
  console.log("=== Accounts to check ===", accounts);

  const runtime = new PlaywrightToolRuntime();

  for (const acc of accounts) {
    const profileDir = `/home/userroot/文档/claw/data/profiles/account-${acc.id}/msedge`;
    console.log(`\n--- Checking Account #${acc.id} (${acc.name}) ---`);
    const traceContext = {
      sessionKey: `check-login-${acc.id}`,
      profileDir,
      publishJobId: null,
      publishAttemptId: null,
      traceGroupId: `check-login-${acc.id}`,
      agentName: "publish_agent",
      stage: "login_checking"
    };

    try {
      await runtime.open(traceContext, { url: "https://www.zhihu.com/settings/account" });
      await runtime.wait(traceContext, { ms: 3000 });
      const snap = await runtime.snapshot(traceContext);
      console.log(`URL: ${snap.url}`);
      console.log(`Title: ${snap.title}`);
      
      const isLogin = snap.url.includes("/signin") || snap.url.includes("/login");
      const isSettings = snap.url.includes("/settings/account");
      console.log(`Result: ${isSettings ? "LOGGED IN OK" : isLogin ? "NOT LOGGED IN (Signin redirected)" : "UNKNOWN"}`);
    } catch (err) {
      console.log(`Error checking account #${acc.id}:`, err.message);
    } finally {
      await runtime.closeSession(traceContext.sessionKey);
    }
  }

  await pool.end();
}

main().catch(console.error);
