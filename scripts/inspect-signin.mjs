import { PlaywrightToolRuntime } from "../packages/core/dist/core/src/index.js";

async function main() {
  const accountId = process.argv[2] || "4";
  const runtime = new PlaywrightToolRuntime();
  const traceContext = {
    sessionKey: `capture-signin-${accountId}`,
    profileDir: `/home/userroot/文档/claw/data/profiles/account-${accountId}/msedge`,
    publishJobId: null,
    publishAttemptId: null,
    traceGroupId: `capture-signin-${accountId}`,
    agentName: "publish_agent",
    stage: "login_checking"
  };

  try {
    console.log(`Opening signin page for Account #${accountId}...`);
    await runtime.open(traceContext, { url: "https://www.zhihu.com/signin" });
    await runtime.wait(traceContext, { ms: 3000 });

    const snap = await runtime.snapshot(traceContext);
    console.log("Snapshot URL:", snap.url);
    console.log("Buttons:", snap.buttons);

    // Look for QR code toggle or elements
    const pageInfo = await runtime.runWithTrace(traceContext, "inspect", {}, async (page) => {
      return page.evaluate(() => {
        const qrToggles = Array.from(document.querySelectorAll("[class*='qrcode'], [class*='Qrcode'], [aria-label*='二维码'], [aria-label*='扫码']"))
          .map(el => ({ className: el.className, text: el.textContent, outerHTML: el.outerHTML.slice(0, 150) }));
        return { qrToggles };
      });
    });
    console.log("QR info:", pageInfo);

    const shot = await runtime.screenshot(traceContext, { label: `signin-account-${accountId}` });
    console.log("Screenshot saved at:", shot.screenshotPath);

  } finally {
    await runtime.closeSession(traceContext.sessionKey);
  }
}

main().catch(console.error);
