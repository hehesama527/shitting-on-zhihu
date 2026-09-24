import { PlaywrightToolRuntime } from "../packages/core/dist/core/src/index.js";

async function main() {
  const runtime = new PlaywrightToolRuntime();
  const traceContext = {
    sessionKey: "test-click-account-4",
    profileDir: "/home/userroot/文档/claw/data/profiles/account-4/msedge",
    publishJobId: 450,
    publishAttemptId: null,
    traceGroupId: "test-click",
    agentName: "publish_agent",
    stage: "publishing"
  };

  try {
    console.log("1. Opening question page...");
    await runtime.open(traceContext, { url: "https://www.zhihu.com/question/2001668790279245831" });
    await runtime.wait(traceContext, { ms: 4000 });

    const beforeSnapshot = await runtime.snapshot(traceContext);
    console.log("Before click - URL:", beforeSnapshot.url);
    console.log("Before click - Buttons containing 回答:", beforeSnapshot.buttons.filter(b => b.includes("回答")));

    console.log("2. Clicking write answer button...");
    const clickResult = await runtime.click(traceContext, {
      selectors: [
        ".QuestionHeaderActions button.WriteAnswerButton",
        "button.WriteAnswerButton",
        "button:has-text('写回答')",
        "button:has-text('编辑回答')"
      ],
      names: ["写回答", "编辑回答"],
      roles: ["button"]
    });
    console.log("Click result:", clickResult);

    await runtime.wait(traceContext, { ms: 4000 });

    const afterSnapshot = await runtime.snapshot(traceContext);
    console.log("After click - URL:", afterSnapshot.url);
    console.log("After click - Buttons containing 回答/发布:", afterSnapshot.buttons.filter(b => b.includes("回答") || b.includes("发布")));
    console.log("After click - EditorContent:", afterSnapshot.editorContent);

    // Let's inspect the DOM for textareas, contenteditables, DraftEditor
    const domInfo = await runtime.runWithTrace(traceContext, "inspect", {}, async (page) => {
      return page.evaluate(() => {
        const editors = Array.from(document.querySelectorAll("[contenteditable], [role='textbox'], .public-DraftEditor-content, textarea"))
          .map(el => ({
            tagName: el.tagName,
            className: el.className,
            role: el.getAttribute("role"),
            contentEditable: el.getAttribute("contenteditable"),
            outerHTML: el.outerHTML.slice(0, 200)
          }));
        return { editors, bodyLength: document.body.innerHTML.length };
      });
    });
    console.log("DOM Editors found:", JSON.stringify(domInfo, null, 2));

  } finally {
    await runtime.closeSession(traceContext.sessionKey);
  }
}

main().catch(console.error);
