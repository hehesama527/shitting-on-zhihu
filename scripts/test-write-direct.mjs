import { PlaywrightToolRuntime } from "../packages/core/dist/core/src/index.js";

async function main() {
  const runtime = new PlaywrightToolRuntime();
  const traceContext = {
    sessionKey: "test-write-url",
    profileDir: "/home/userroot/文档/claw/data/profiles/account-4/msedge",
    publishJobId: 450,
    publishAttemptId: null,
    traceGroupId: "test-write-url",
    agentName: "publish_agent",
    stage: "publishing"
  };

  try {
    console.log("Navigating to /write URL directly...");
    await runtime.open(traceContext, { url: "https://www.zhihu.com/question/2001668790279245831/write" });
    await runtime.wait(traceContext, { ms: 4000 });

    const snap = await runtime.snapshot(traceContext);
    console.log("URL after goto /write:", snap.url);
    console.log("Title:", snap.title);
    console.log("Buttons:", snap.buttons);
    console.log("EditorContent (first 100 chars):", snap.editorContent?.slice(0, 100));

    const domInfo = await runtime.runWithTrace(traceContext, "inspect", {}, async (page) => {
      return page.evaluate(() => {
        const editors = Array.from(document.querySelectorAll("[contenteditable='true'], .public-DraftEditor-content, textarea"))
          .map(el => ({
            tagName: el.tagName,
            className: el.className,
            role: el.getAttribute("role"),
            text: (el.textContent || "").slice(0, 60)
          }));
        return { editors, url: window.location.href };
      });
    });
    console.log("DOM Editors info:", JSON.stringify(domInfo, null, 2));

  } finally {
    await runtime.closeSession(traceContext.sessionKey);
  }
}

main().catch(console.error);
