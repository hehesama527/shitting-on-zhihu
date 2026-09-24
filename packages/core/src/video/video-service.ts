import fs from "node:fs/promises";
import path from "node:path";
import type {
  VideoFeedbackDocumentSummary,
  VideoScriptPack,
  VideoTargetPlatform,
  VideoTopicFeedbackDecision,
  VideoTopicSource,
  VisualRenderPlan
} from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";
import type { FeishuNotificationService } from "../services/feishu-notification-service.js";
import type { VideoAgentService } from "./video-agent-service.js";
import type { VideoRepository } from "./video-repository.js";
import { VideoAssetStorage } from "./video-workers.js";

export class VideoService {
  constructor(
    private readonly repository: VideoRepository,
    private readonly agentService: VideoAgentService,
    private readonly feishuNotificationService: FeishuNotificationService,
    private readonly storage = new VideoAssetStorage()
  ) {}

  async getHubSummary() {
    const [topicBatches, candidates, projects, feedbackDocuments] = await Promise.all([
      this.repository.listTopicBatches(20),
      this.repository.listTopicCandidates(50),
      this.repository.listProjects(50),
      this.repository.listFeedbackDocuments(20)
    ]);
    return {
      topicBatches,
      candidates,
      projects,
      feedbackDocuments
    };
  }

  async createTopicBatch(input: {
    source: VideoTopicSource;
    targetPlatform: VideoTargetPlatform;
    targetCount: number;
    productBrief?: string;
    audience?: string;
    userRequirement?: string;
    hotspot?: unknown;
  }) {
    const output = await this.agentService.generateTopics(input);
    const batch = await this.repository.createTopicBatch({
      source: input.source,
      targetPlatform: input.targetPlatform,
      targetCount: input.targetCount,
      input,
      output
    });
    await this.feishuNotificationService.sendVideoTopicNotification({
      batchId: batch?.id ?? "unknown",
      source: input.source,
      count: output.candidates.length,
      entryUrl: `${getAppConfig().webUrl.replace(/\/+$/, "")}/videos/topics`
    });
    return batch;
  }

  async refillTopicBatch(batchId: string, input: { targetCount: number; userRequirement?: string }) {
    const batch = await this.repository.getTopicBatch(batchId);
    if (!batch) {
      throw new Error("Video topic batch not found.");
    }
    return this.createTopicBatch({
      source: "refill",
      targetPlatform: batch.targetPlatform,
      targetCount: input.targetCount,
      userRequirement: input.userRequirement
    });
  }

  async scoreHotspot(input: {
    hotspot: unknown;
    productBrief?: string;
    audience?: string;
    targetPlatform: VideoTargetPlatform;
  }) {
    const scored = await this.agentService.scoreHotspot(input);
    const accepted = scored.score >= getAppConfig().videoHotspotTopicThreshold && Boolean(scored.candidate);
    let batchId: string | null = null;

    if (accepted && scored.candidate) {
      const batch = await this.repository.createTopicBatch({
        source: "hotspot",
        targetPlatform: input.targetPlatform,
        targetCount: 1,
        input,
        output: {
          summary: scored.reason,
          candidates: [
            {
              ...scored.candidate,
              score: scored.score,
              topicFitScore: scored.topicFitScore,
              productionScore: scored.productionScore
            }
          ]
        }
      });
      batchId = batch?.id ?? null;
      await this.feishuNotificationService.sendVideoTopicNotification({
        batchId: batchId ?? "unknown",
        source: "hotspot",
        count: 1,
        entryUrl: `${getAppConfig().webUrl.replace(/\/+$/, "")}/videos/topics`
      });
    }

    return {
      ...scored,
      accepted,
      batchId
    };
  }

  async saveTopicFeedback(candidateId: string, input: { decision: VideoTopicFeedbackDecision; reason?: string; suggestion?: string }) {
    return this.repository.saveTopicFeedback({
      candidateId,
      decision: input.decision,
      reason: input.reason,
      suggestion: input.suggestion
    });
  }

  async createProject(topicCandidateId: string, title?: string | null) {
    return this.repository.createProjectFromCandidate(topicCandidateId, title);
  }

  async generateScript(projectId: string, revisionInstruction = "", verifiedCasePackId?: string | null) {
    const project = await this.repository.getProjectDetail(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    if (!project.topic) {
      throw new Error("Video project topic is missing.");
    }
    if (project.status === "topic_selected") {
      await this.repository.setProjectStatus(projectId, "writing", "WriterAgent started.");
    } else if (project.status !== "script_pending_confirmation") {
      throw new Error("Script generation is only available before confirmation or while a script is pending confirmation.");
    }
    const verifiedCasePack = verifiedCasePackId
      ? await this.repository.getVerifiedCasePack(verifiedCasePackId)
      : await this.repository.getLatestReadyVerifiedCasePack(projectId);
    if (verifiedCasePackId && !verifiedCasePack) {
      throw new Error("Verified case pack not found.");
    }
    if (verifiedCasePack && verifiedCasePack.projectId !== projectId) {
      throw new Error("Verified case pack does not belong to this video project.");
    }
    const scriptPack = await this.agentService.generateScript({
      projectId,
      topic: project.topic,
      previousScriptPack: project.scriptPack,
      revisionInstruction,
      verifiedCasePack: verifiedCasePack?.pack ?? null
    });
    await this.repository.saveScriptPack(projectId, scriptPack, true);
    return this.repository.getProjectDetail(projectId);
  }

  async saveScript(projectId: string, scriptPack: VideoScriptPack) {
    await this.repository.saveScriptPack(projectId, scriptPack, true);
    return this.repository.getProjectDetail(projectId);
  }

  async confirmScript(projectId: string) {
    await this.repository.confirmScriptPack(projectId);
    return this.repository.getProjectDetail(projectId);
  }

  async generateVisualPlan(projectId: string) {
    const project = await this.repository.getProjectDetail(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    if (!project.scriptPack) {
      throw new Error("Video script pack is missing.");
    }
    const plan = await this.agentService.generateVisualPlan({
      projectId,
      scriptPack: project.scriptPack,
      hyperframeEnabled: Boolean(getAppConfig().hyperframeBaseUrl)
    });
    const normalizedPlan = normalizeVisualPlan(plan);
    await this.repository.saveVisualRenderPlan(projectId, normalizedPlan);
    return this.repository.getProjectDetail(projectId);
  }

  async saveVisualPlan(projectId: string, visualRenderPlan: VisualRenderPlan) {
    await this.repository.saveVisualRenderPlan(projectId, normalizeVisualPlan(visualRenderPlan));
    return this.repository.getProjectDetail(projectId);
  }

  async confirmVisualPlan(projectId: string) {
    await this.repository.confirmVisualRenderPlan(projectId);
    return this.repository.getProjectDetail(projectId);
  }

  async enqueueAssets(projectId: string) {
    await this.repository.enqueueAssetProduction(projectId);
    return this.repository.getProjectDetail(projectId);
  }

  async enqueueComposition(projectId: string) {
    await this.repository.enqueueComposition(projectId);
    return this.repository.getProjectDetail(projectId);
  }

  async approveProject(projectId: string) {
    await this.repository.approveProject(projectId);
    return this.repository.getProjectDetail(projectId);
  }

  async createFeedbackDocument(input: {
    scope: VideoFeedbackDocumentSummary["scope"];
    projectId?: string | null;
    notes: string;
  }) {
    const project = input.projectId ? await this.repository.getProjectDetail(input.projectId) : null;
    const markdown = await this.agentService.summarizeFeedback({
      scope: input.scope,
      notes: input.notes,
      project
    });
    const feedbackDir = await this.storage.ensureFeedbackDir();
    const filePath = path.join(feedbackDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${input.scope}.md`);
    await fs.writeFile(filePath, markdown, "utf8");
    const id = await this.repository.createFeedbackDocument({
      scope: input.scope,
      projectId: input.projectId ?? null,
      markdown,
      summaryJson: {
        scope: input.scope,
        projectId: input.projectId ?? null
      },
      filePath
    });
    return {
      id,
      markdown,
      filePath
    };
  }
}

function normalizeVisualPlan(plan: VisualRenderPlan): VisualRenderPlan {
  const hyperframeEnabled = Boolean(getAppConfig().hyperframeBaseUrl);
  return {
    ...plan,
    aspectRatio: "16:9",
    resolution: {
      width: 1920,
      height: 1080
    },
    segments: plan.segments.map((segment) =>
      segment.builder === "hyperframe" && !hyperframeEnabled
        ? {
            ...segment,
            blockingIssue:
              segment.blockingIssue ??
              "HYPERFRAME_BASE_URL is not configured. Confirm Hyperframe before production or change builder."
          }
        : segment
    )
  };
}
