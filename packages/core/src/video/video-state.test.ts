import assert from "node:assert/strict";
import test from "node:test";
import {
  createVideoCaseIntentSchema,
  videoScriptPackSchema,
  videoVerifiedCasePackSchema,
  visualRenderPlanSchema
} from "@zhihu-mvp/shared";
import { assertVideoProjectTransition, canStartVideoAssetProduction } from "./video-state.js";

test("video project state machine allows the MVP happy path", () => {
  const path = [
    "topic_selected",
    "writing",
    "script_pending_confirmation",
    "render_plan_pending_confirmation",
    "script_confirmed",
    "assets_pending",
    "voice_rendering",
    "visual_rendering",
    "assets_ready",
    "composing",
    "video_ready",
    "approved"
  ] as const;

  for (let i = 0; i < path.length - 1; i += 1) {
    assert.doesNotThrow(() => assertVideoProjectTransition(path[i], path[i + 1]));
  }
});

test("asset production requires both user confirmations", () => {
  assert.equal(
    canStartVideoAssetProduction({
      scriptConfirmedAt: "2026-05-25T00:00:00.000Z",
      visualRenderPlanConfirmedAt: null
    }),
    false
  );
  assert.equal(
    canStartVideoAssetProduction({
      scriptConfirmedAt: "2026-05-25T00:00:00.000Z",
      visualRenderPlanConfirmedAt: "2026-05-25T00:01:00.000Z"
    }),
    true
  );
});

test("visual rendering cannot start before voice rendering", () => {
  assert.throws(() => assertVideoProjectTransition("assets_pending", "visual_rendering"));
  assert.doesNotThrow(() => assertVideoProjectTransition("assets_pending", "voice_rendering"));
  assert.doesNotThrow(() => assertVideoProjectTransition("voice_rendering", "visual_rendering"));
});

test("video script and visual render plan schemas enforce horizontal MVP contracts", () => {
  const script = videoScriptPackSchema.parse({
    title: "测试视频",
    topicId: "topic-1",
    aspectRatio: "16:9",
    targetDurationSec: 40,
    voiceoverFullText: "这是一段测试口播。",
    segments: [
      {
        segmentId: "seg-1",
        order: 1,
        title: "第一段",
        voiceover: "这是一段测试口播。",
        subtitle: "测试字幕",
        durationSec: 8,
        imagePrompt: "横版 16:9 测试画面",
        visualIntent: "标题卡"
      }
    ]
  });

  const plan = visualRenderPlanSchema.parse({
    projectId: "project-1",
    aspectRatio: "16:9",
    resolution: {
      width: 1920,
      height: 1080
    },
    segments: [
      {
        segmentId: script.segments[0].segmentId,
        order: 1,
        builder: "remotion_card",
        reason: "结构化标题卡"
      }
    ]
  });

  assert.equal(script.aspectRatio, "16:9");
  assert.equal(plan.resolution.width, 1920);
});

test("video case schemas capture formal evidence chain contracts", () => {
  const intent = createVideoCaseIntentSchema.parse({
    symbol: "btcusdt",
    interval: "4h",
    startTime: "2024-01-01T00:00:00.000Z",
    endTime: "2025-01-01T00:00:00.000Z"
  });

  const pack = videoVerifiedCasePackSchema.parse({
    caseId: "case_btcusdt_4h_2024_sma20_60",
    status: "ready",
    createdAt: "2026-05-26T00:00:00.000Z",
    dataSource: {
      kind: "mongodb",
      database: "crypto_data_new",
      collection: "BTCUSDT_4h"
    },
    caseIntent: {
      id: "intent-1"
    },
    strategy: {
      name: "SMA fast/slow long-only crossover"
    },
    metrics: {
      returnPct: 41.78
    },
    review: {
      allowedFacts: ["本地 MongoDB 证据包可复查。"],
      findings: ["窗口收益为正不等于策略有效。"],
      hypotheses: ["需要跨年份复验。"],
      forbiddenClaims: ["该策略有效"],
      contentSafety: {
        mustSay: ["这不是投资建议。"]
      }
    }
  });

  assert.equal(intent.symbol, "BTCUSDT");
  assert.equal(intent.strategy?.fastWindow, undefined);
  assert.equal(pack.status, "ready");
  assert.equal(pack.review.forbiddenClaims.includes("该策略有效"), true);
});
