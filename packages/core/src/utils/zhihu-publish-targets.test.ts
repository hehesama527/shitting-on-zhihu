import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findZhihuPublishLabel,
  isZhihuPublishLabel,
  normalizeZhihuPublishLabel
} from "./zhihu-publish-targets.js";

test("submit matching accepts 提交修改 and rejects 发布设置", () => {
  assert.equal(findZhihuPublishLabel(["发布设置", "提交修改"], "submit"), "提交修改");
  assert.equal(isZhihuPublishLabel("发布设置", "submit"), false);
});

test("publish matching ignores whitespace and zero-width characters", () => {
  assert.equal(normalizeZhihuPublishLabel("\u200b 提交  修改 "), "提交修改");
  assert.equal(isZhihuPublishLabel("\u200b提交修改", "submit"), true);
});

test("body text is not treated as an action label", () => {
  assert.equal(findZhihuPublishLabel(["正文提到提交修改，但不是按钮"], "submit"), null);
});
