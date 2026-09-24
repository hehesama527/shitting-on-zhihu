import { PlaywrightToolRuntime, getMysqlPool } from "../packages/core/dist/core/src/index.js";

async function main() {
  const runtime = new PlaywrightToolRuntime();
  const traceContext = {
    sessionKey: "inspect-btn-account-4",
    profileDir: "/home/userroot/文档/claw/data/profiles/account-4/msedge",
    publishJobId: 450,
    publishAttemptId: null,
    traceGroupId: "inspect-btn",
    agentName: "publish_agent",
    stage: "publishing"
  };

  await runtime.open(traceContext, { url: "https://www.zhihu.com/question/2001668790279245831" });
  await runtime.wait(traceContext, { ms: 3000 });

  const info = await runtime.runWithTrace(traceContext, "inspect", {}, async (page) => {
    return page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll("button, a, div[role='button']"))
        .filter(el => (el.textContent || "").includes("回答"))
        .map(el => ({
          tagName: el.tagName,
          className: el.className,
          text: (el.textContent || "").trim(),
          href: el.getAttribute("href"),
          outerHTML: el.outerHTML.slice(0, 300)
        }));
      return candidates;
    });
  });

  console.log("Found answer elements:", JSON.stringify(info, null, 2));
  await runtime.closeSession(traceContext.sessionKey);
}

main().catch(console.error);
