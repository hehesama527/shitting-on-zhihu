import assert from "node:assert/strict";
import test from "node:test";
import { videoMotionPlanSchema, type VideoProjectDetail } from "@zhihu-mvp/shared";
import { buildVideoMotionPlan } from "./video-motion-planner.js";

test("video motion plan schema accepts a v3-style semantic chart scene", () => {
  const plan = videoMotionPlanSchema.parse({
    version: "motion-plan-v1",
    projectId: "project-1",
    title: "跨窗口复盘",
    aspectRatio: "16:9",
    resolution: {
      width: 1920,
      height: 1080
    },
    totalDurationMs: 6000,
    maxSceneDurationMs: 12000,
    generatedAt: "2026-05-28T00:00:00.000Z",
    source: {
      planner: "deterministic_v1",
      inputs: ["video_project_segments", "video_assets.voice.duration_ms"]
    },
    dataBindings: [
      {
        key: "market_window_comparison:case-1",
        type: "market_window_comparison",
        source: "verified_case_pack.chartData",
        label: "跨窗口行情数据",
        required: true
      }
    ],
    scenes: [
      {
        sceneId: "seg-1-scene-01-real_market_chart",
        segmentId: "segment-row-1",
        segmentKey: "seg-1",
        order: 1,
        startMs: 0,
        endMs: 6000,
        durationMs: 6000,
        sceneType: "real_market_chart",
        narrationIntent: "介绍比特币历史数据来源",
        dataRef: {
          type: "market_window",
          key: "btc_4h_bull_window",
          source: "verified_case_pack.chartData",
          label: "比特币历史窗口"
        },
        visualFocus: "真实价格走势逐步绘制",
        textOverlays: [
          {
            text: "比特币历史数据",
            role: "headline",
            position: "top_left"
          }
        ],
        motion: {
          transition: "match_cut",
          camera: "track_chart",
          chartDraw: "continuous",
          emphasis: "last_price_dot",
          layerAnimations: ["axis_fade_in", "price_path_draw_continuous"]
        },
        requiredAssetTypes: ["voice", "chart"],
        qaRules: []
      }
    ],
    qaRules: [],
    notes: []
  });

  assert.equal(plan.aspectRatio, "16:9");
  assert.equal(plan.scenes[0].motion.chartDraw, "continuous");
});

test("deterministic motion planner splits long narration into semantic micro-scenes", () => {
  const plan = buildVideoMotionPlan(createMockProject(), {
    generatedAt: "2026-05-28T00:00:00.000Z"
  });

  assert.equal(plan.version, "motion-plan-v1");
  assert.equal(plan.aspectRatio, "16:9");
  assert.ok(plan.scenes.length >= 5);
  assert.ok(plan.scenes.every((scene) => scene.durationMs <= plan.maxSceneDurationMs));
  assert.ok(plan.scenes.some((scene) => scene.sceneType === "hook_curve_warning"));
  assert.ok(plan.scenes.some((scene) => scene.sceneType === "real_market_chart"));
  assert.ok(plan.scenes.some((scene) => scene.sceneType === "ma_crossover_rule"));
  assert.ok(plan.scenes.some((scene) => scene.sceneType === "window_comparison"));
});

test("motion planner sanitizes public overlays and binds chart scenes to evidence", () => {
  const plan = buildVideoMotionPlan(createMockProject(), {
    generatedAt: "2026-05-28T00:00:00.000Z"
  });

  const overlayText = plan.scenes.flatMap((scene) => scene.textOverlays.map((overlay) => overlay.text)).join("\n");
  assert.equal(/BTCUSDT|MongoDB|crypto_data_new|VerifiedCasePack|CaseIntent|ReviewAgent/i.test(overlayText), false);
  assert.ok(plan.dataBindings.some((binding) => binding.type === "verified_case_pack"));
  assert.ok(
    plan.scenes
      .filter((scene) => ["real_market_chart", "ma_crossover_rule", "window_comparison"].includes(scene.sceneType))
      .every((scene) => scene.dataRef.type !== "none")
  );
});

function createMockProject(): VideoProjectDetail {
  return {
    id: "project-1",
    topicCandidateId: "topic-1",
    title: "BTCUSDT 跨窗口复盘：别让一个牛市区间代表全部历史",
    status: "assets_ready",
    targetPlatform: "manual",
    aspectRatio: "16:9",
    targetDurationSec: 42,
    scriptConfirmedAt: "2026-05-28T00:00:00.000Z",
    visualRenderPlanConfirmedAt: "2026-05-28T00:01:00.000Z",
    finalVideoAssetId: null,
    errorMessage: null,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    topic: null,
    scriptPack: null,
    visualRenderPlan: null,
    segments: [
      {
        id: "segment-row-1",
        projectId: "project-1",
        segmentKey: "seg-1",
        order: 1,
        title: "BTCUSDT 历史数据复盘",
        voiceover:
          "先看一条曲线，千万别急着下结论。很多策略最容易骗人，就是只拿一段牛市窗口出来讲。接下来我们换成比特币的真实历史数据，把价格走势先画出来。规则很简单，用快线和慢线判断买入和卖出。只看二零二零到二零二一这段，结果会显得特别漂亮，赚了130%多。但如果把窗口换到下跌和震荡阶段，结果就完全不一样。三段窗口放在一起，你会发现问题不在某一次收益，而在样本太少。",
        subtitle: "用真实数据复盘，别让单一窗口骗了你",
        imagePrompt: "横版矢量风格，比特币行情复盘和均线规则解释",
        visualBuilder: "mixed",
        status: "ready",
        durationSec: 42,
        errorMessage: null,
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ],
    assets: [
      {
        id: "voice-1",
        projectId: "project-1",
        segmentId: "segment-row-1",
        assetType: "voice",
        status: "active",
        builder: null,
        filePath: "H:\\claw\\data\\videos\\project-1\\audio\\voice.wav",
        publicUrl: null,
        mimeType: "audio/wav",
        width: null,
        height: null,
        durationMs: 42_000,
        attemptNo: 1,
        errorMessage: null,
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      },
      {
        id: "chart-1",
        projectId: "project-1",
        segmentId: "segment-row-1",
        assetType: "chart",
        status: "active",
        builder: "hyperframe",
        filePath: "H:\\claw\\data\\videos\\project-1\\visuals\\chart.png",
        publicUrl: null,
        mimeType: "image/png",
        width: 1920,
        height: 1080,
        durationMs: null,
        attemptNo: 1,
        errorMessage: null,
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ],
    caseIntents: [],
    verifiedCasePacks: [
      {
        id: "pack-row-1",
        projectId: "project-1",
        caseIntentId: "case-intent-1",
        caseId: "case-btc-window-review",
        status: "ready",
        dataSource: {
          database: "crypto_data_new",
          collection: "BTCUSDT_4h"
        },
        strategy: {
          name: "sma_crossover"
        },
        metrics: {
          returnPct: 133.45
        },
        review: {
          allowedFacts: ["比特币不同历史窗口表现不同"],
          findings: ["单一上涨窗口不能代表完整历史"],
          hypotheses: [],
          forbiddenClaims: ["保证收益"],
          contentSafety: {
            mustSay: ["不构成投资建议"]
          }
        },
        chartData: {
          windows: ["bull", "bear", "chop"]
        },
        pack: {
          caseId: "case-btc-window-review",
          status: "ready",
          createdAt: "2026-05-28T00:00:00.000Z",
          dataSource: {
            database: "crypto_data_new",
            collection: "BTCUSDT_4h"
          },
          caseIntent: {},
          strategy: {},
          metrics: {},
          review: {
            allowedFacts: ["比特币不同历史窗口表现不同"],
            findings: ["单一上涨窗口不能代表完整历史"],
            hypotheses: [],
            forbiddenClaims: ["保证收益"],
            contentSafety: {
              mustSay: ["不构成投资建议"]
            }
          },
          chartData: {
            windows: ["bull", "bear", "chop"]
          }
        },
        errorMessage: null,
        createdAt: "2026-05-28T00:00:00.000Z",
        updatedAt: "2026-05-28T00:00:00.000Z"
      }
    ]
  };
}
