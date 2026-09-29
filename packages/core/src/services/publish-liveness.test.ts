import assert from "node:assert/strict";
import { test } from "node:test";
import { detectQuestionLiveness } from "./publish-service.js";
import type { PageSnapshot } from "./playwright-tool-runtime.js";

function makeSnapshot(partial: Partial<PageSnapshot>): PageSnapshot {
  return {
    url: "https://www.zhihu.com/question/123456",
    title: "一个正常的知乎问题标题 - 知乎",
    visibleTexts: ["问题描述内容", "知乎讨论", "查看全部 10 个回答"],
    buttons: ["关注问题", "写回答"],
    links: [{ text: "查看全部回答", href: "/question/123456" }],
    questionLinks: [],
    editorContent: null,
    editorContentLength: 0,
    editorBoldTexts: [],
    ...partial
  };
}

test("detectQuestionLiveness returns alive:true for normal question page", () => {
  const snapshot = makeSnapshot({});
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, true);
});

test("detectQuestionLiveness returns alive:true when question title discusses 404 but write button exists", () => {
  const snapshot = makeSnapshot({
    title: "为什么很多网站会出现404页面不存在的错误？ - 知乎",
    visibleTexts: ["很多时候我们访问网页会提示404页面不存在，这背后的技术原理是什么？"],
    buttons: ["关注问题", "写回答"]
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, true);
});

test("detectQuestionLiveness detects Zhihu 404 URL", () => {
  const snapshot = makeSnapshot({
    url: "https://www.zhihu.com/404",
    title: "你似乎来到了没有知识存在的荒原 - 知乎",
    visibleTexts: ["你似乎来到了没有知识存在的荒原", "返回首页"],
    buttons: ["返回首页"],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "not_found");
});

test("detectQuestionLiveness detects deleted question ('荒原' text with no write button)", () => {
  const snapshot = makeSnapshot({
    url: "https://www.zhihu.com/question/999999",
    title: "知乎 - 你似乎来到了没有知识存在的荒原",
    visibleTexts: ["你似乎来到了没有知识存在的荒原", "去往首页"],
    buttons: ["去往首页"],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "not_found");
});

test("detectQuestionLiveness detects deleted question ('该内容已被删除')", () => {
  const snapshot = makeSnapshot({
    url: "https://www.zhihu.com/question/888888",
    title: "知乎",
    visibleTexts: ["抱歉，该内容已被删除或不存在", "去往首页"],
    buttons: ["去往首页"],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "not_found");
});

test("detectQuestionLiveness detects closed question ('该问题已关闭')", () => {
  const snapshot = makeSnapshot({
    title: "一个有争议的问题 - 知乎",
    visibleTexts: ["该问题已关闭，无法添加新回答", "查看全部 25 个回答"],
    buttons: ["关注问题"],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "closed");
});

test("detectQuestionLiveness detects locked question ('该问题已被锁定')", () => {
  const snapshot = makeSnapshot({
    title: "已锁定的讨论 - 知乎",
    visibleTexts: ["该问题已被锁定，当前问题暂不支持添加新回答", "仅供浏览"],
    buttons: ["分享"],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "closed");
});

test("detectQuestionLiveness detects Zhihu 40362 risk blocked page", () => {
  const snapshot = makeSnapshot({
    title: "",
    visibleTexts: [
      '{"error":{"message":"您当前请求存在异常，暂时限制本次访问。如有疑问，您可以通过手机摇一摇或登录后私信知乎小管家反馈。c936b8157d887cee3c366f509a3f6132","code":40362}}'
    ],
    buttons: [],
    links: []
  });
  const result = detectQuestionLiveness(snapshot);
  assert.equal(result.alive, false);
  assert.equal(result.subType, "blocked");
  assert.ok(result.reason.includes("40362"));
});

