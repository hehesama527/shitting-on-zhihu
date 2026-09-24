import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReviewTargetProductPromptSuffix,
  buildTopicTargetProductPromptSuffix,
  buildWriterTargetProductPromptSuffix,
  buildReviewAccountLibraryPromptSuffix,
  buildWriterAccountLibraryPromptSuffix
} from "./account-prompt-context.js";

test("target/product suffixes inject business context without turning it into examples", () => {
  const context = {
    targetMarkdown: "# Target\nAnswer first. Promote only when useful.",
    productMarkdown: "# Product\nCryptoPathX validates strategies. Do not claim guaranteed profit.",
    targetPath: "target.md",
    productPath: "product.md"
  };

  const topicSuffix = buildTopicTargetProductPromptSuffix(context);
  const writerSuffix = buildWriterTargetProductPromptSuffix(context);
  const reviewSuffix = buildReviewTargetProductPromptSuffix(context);

  assert.match(topicSuffix ?? "", /选题 Agent 用法/);
  assert.match(writerSuffix ?? "", /写作 Agent 用法/);
  assert.match(reviewSuffix ?? "", /审核 Agent 用法/);
  assert.match(writerSuffix ?? "", /不是检索材料、范文、文风样本或来源素材/);
  assert.match(reviewSuffix ?? "", /guaranteed profit/);
});

test("writer account-library suffix includes style, structure, evidence, and only the first three good answers", () => {
  const suffix = buildWriterAccountLibraryPromptSuffix({
    accountKey: "account_1",
    matchedBy: "accountId",
    styleRulesMarkdown: "# Style\n- 用克制口吻回答。",
    answerStructureRulesMarkdown: "# Structure\n- 开头先下判断，再补原因。",
    evidenceRulesMarkdown: "# Evidence\n- 多用具体情境和数字。",
    reviewRubricMarkdown: "",
    sampleFilterMarkdown: "",
    goodAnswers: [
      buildExample("good-1", "好样本一"),
      buildExample("good-2", "好样本二"),
      buildExample("good-3", "好样本三"),
      buildExample("good-4", "好样本四")
    ],
    badAnswers: []
  });

  assert.ok(suffix);
  assert.match(suffix ?? "", /style_rules\.md/);
  assert.match(suffix ?? "", /answer_structure_rules\.md/);
  assert.match(suffix ?? "", /evidence_rules\.md/);
  assert.match(suffix ?? "", /好样本一/);
  assert.match(suffix ?? "", /好样本三/);
  assert.doesNotMatch(suffix ?? "", /好样本四/);
});

test("review account-library suffix includes style, rubric, three bad answers, and a single good anchor", () => {
  const suffix = buildReviewAccountLibraryPromptSuffix({
    accountKey: "account_2",
    matchedBy: "accountName",
    styleRulesMarkdown: "# Style\n- 不要喊口号。",
    answerStructureRulesMarkdown: "",
    evidenceRulesMarkdown: "",
    reviewRubricMarkdown: "# Rubric\n- 抓人设失真和 AI 味。",
    sampleFilterMarkdown: "",
    goodAnswers: [buildExample("good-1", "正向锚点"), buildExample("good-2", "不该出现")],
    badAnswers: [
      buildExample("bad-1", "反例一"),
      buildExample("bad-2", "反例二"),
      buildExample("bad-3", "反例三"),
      buildExample("bad-4", "反例四")
    ]
  });

  assert.ok(suffix);
  assert.match(suffix ?? "", /style_rules\.md/);
  assert.match(suffix ?? "", /review_rubric\.md/);
  assert.match(suffix ?? "", /反例一/);
  assert.match(suffix ?? "", /反例三/);
  assert.doesNotMatch(suffix ?? "", /反例四/);
  assert.match(suffix ?? "", /正向锚点/);
  assert.doesNotMatch(suffix ?? "", /不该出现/);
});

test("account-library suffix ignores bootstrap placeholder documents when nothing meaningful is present", () => {
  const writerSuffix = buildWriterAccountLibraryPromptSuffix({
    accountKey: "account_3",
    matchedBy: "accountId",
    styleRulesMarkdown: [
      "# Test Style Rules",
      "",
      "## Purpose",
      "",
      "- Fill this file with stable voice rules after note-agent apply.",
      "- Writer and Review read this file as the first account-specific style layer."
    ].join("\n"),
    answerStructureRulesMarkdown: "",
    evidenceRulesMarkdown: "",
    reviewRubricMarkdown: "",
    sampleFilterMarkdown: "",
    goodAnswers: [],
    badAnswers: []
  });
  const reviewSuffix = buildReviewAccountLibraryPromptSuffix({
    accountKey: "account_3",
    matchedBy: "accountId",
    styleRulesMarkdown: "",
    answerStructureRulesMarkdown: "",
    evidenceRulesMarkdown: "",
    reviewRubricMarkdown: [
      "# Test Review Rubric",
      "",
      "## Purpose",
      "",
      "- Review voice fit, structure fit, AI smell, and naturalness for this account.",
      "- Reject copied-source writing and generic slogan-heavy answers."
    ].join("\n"),
    sampleFilterMarkdown: "",
    goodAnswers: [],
    badAnswers: []
  });

  assert.equal(writerSuffix, null);
  assert.equal(reviewSuffix, null);
});

function buildExample(id: string, text: string) {
  return {
    id,
    text: `${text}：这是一段用于锚定节奏和结构的示例内容，会把复盘路径、判断逻辑和表达克制度都带出来。`,
    notes: `${text} 的说明`,
    questionTitle: `${text} 的问题`,
    questionUrl: null,
    answerUrl: null
  };
}
