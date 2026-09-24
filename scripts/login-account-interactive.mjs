import { PlaywrightToolRuntime, getMysqlPool } from "../packages/core/dist/core/src/index.js";
import fs from "node:fs/promises";
import path from "node:path";

async function main() {
  const accountId = process.argv[2] || "4";
  const pool = getMysqlPool();
  const [rows] = await pool.execute("SELECT id, name FROM accounts WHERE id = ?", [accountId]);
  const accountName = rows[0]?.name || `账号 #${accountId}`;

  console.log(`\n======================================================`);
  console.log(`🚀 开始为 ${accountName} (ID: ${accountId}) 启动知乎扫码登录流程`);
  console.log(`======================================================\n`);

  const runtime = new PlaywrightToolRuntime();
  const traceContext = {
    sessionKey: `login-qr-account-${accountId}`,
    profileDir: `/home/userroot/文档/claw/data/profiles/account-${accountId}/msedge`,
    publishJobId: null,
    publishAttemptId: null,
    traceGroupId: `login-qr-${accountId}`,
    agentName: "publish_agent",
    stage: "login_checking"
  };

  try {
    console.log("1. 打开知乎登录页...");
    await runtime.open(traceContext, { url: "https://www.zhihu.com/signin" });
    await runtime.wait(traceContext, { ms: 3000 });

    const qrPath = `/home/userroot/文档/claw/data/screenshots/login-qr-${accountId}.png`;
    const shot = await runtime.screenshot(traceContext, { label: `login-qr-${accountId}` });
    console.log(`\n📸 二维码已截取并保存至: ${shot.screenshotPath}`);
    console.log(`请使用知乎 App 或微信扫一扫完成登录（有效时间 3 分钟）...\n`);

    const startTime = Date.now();
    let loggedIn = false;

    while (Date.now() - startTime < 180_000) {
      await runtime.wait(traceContext, { ms: 3000 });
      const snap = await runtime.snapshot(traceContext);
      
      const isStillSignin = snap.url.includes("/signin") || snap.url.includes("/login");
      const hasAvatarOrHome = snap.buttons.some(b => b.includes("消息") || b.includes("创作中心") || b.includes("我的") || b.includes("发想法"));
      const isRootOrSettings = snap.url === "https://www.zhihu.com/" || snap.url.includes("/settings");

      if (!isStillSignin && (hasAvatarOrHome || isRootOrSettings)) {
        console.log(`\n🎉 检测到登录成功！当前页面: ${snap.url}`);
        loggedIn = true;
        break;
      }
      process.stdout.write(".");
    }

    if (loggedIn) {
      console.log("\n正在持久化会话凭证并激活账号...");
      await runtime.wait(traceContext, { ms: 3000 });
      await pool.execute("UPDATE accounts SET status = 'active' WHERE id = ?", [accountId]);
      console.log(`✅ 账号 #${accountId} (${accountName}) 状态已更新为 active！`);
    } else {
      console.log("\n⏰ 扫码超时，请重新运行登录脚本。");
    }

  } finally {
    console.log("\n关闭登录浏览器会话...");
    await runtime.closeSession(traceContext.sessionKey);
    await pool.end();
    console.log("✨ 会话已清理。");
  }
}

main().catch(console.error);
