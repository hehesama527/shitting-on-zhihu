import { getAppConfig } from "../config/env.js";
import type { VideoAgentService } from "./video-agent-service.js";
import type { VideoRepository } from "./video-repository.js";
import { VideoComposerWorker, VisualRenderWorker, VoiceRenderWorker, VideoAssetStorage } from "./video-workers.js";
import type { VideoService } from "./video-service.js";

export type VideoWorkerTickSummary = {
  weeklyTopicTriggered: boolean;
  processedProjects: number;
  failures: Array<{ projectId: string; message: string }>;
};

export class VideoWorkerRunner {
  private readonly storage: VideoAssetStorage;
  private readonly voiceWorker: VoiceRenderWorker;
  private readonly visualWorker: VisualRenderWorker;
  private readonly composerWorker: VideoComposerWorker;

  constructor(
    private readonly repository: VideoRepository,
    private readonly service: VideoService,
    private readonly _agentService: VideoAgentService
  ) {
    this.storage = new VideoAssetStorage();
    this.voiceWorker = new VoiceRenderWorker(repository, this.storage);
    this.visualWorker = new VisualRenderWorker(repository, this.storage);
    this.composerWorker = new VideoComposerWorker(repository, this.storage);
  }

  async tick(): Promise<VideoWorkerTickSummary> {
    const summary: VideoWorkerTickSummary = {
      weeklyTopicTriggered: false,
      processedProjects: 0,
      failures: []
    };

    if (await this.shouldTriggerWeeklyTopics()) {
      await this.service.createTopicBatch({
        source: "weekly",
        targetPlatform: "agnostic",
        targetCount: getAppConfig().videoWeeklyTopicCount,
        productBrief: "通用视频中台每周选题生成。请结合历史反馈，优先输出可做成横版视频的选题。",
        audience: "内部内容运营与产品团队"
      });
      summary.weeklyTopicTriggered = true;
    }

    const projects = await this.repository.listProjectsForWorker(5);
    for (const projectSummary of projects) {
      try {
        const project = await this.repository.getProjectDetail(projectSummary.id);
        if (!project) {
          continue;
        }

        if (project.status === "assets_pending") {
          await this.repository.setProjectStatus(project.id, "voice_rendering", "Voice render worker started.");
          await this.voiceWorker.renderProject(project);
          const afterVoice = await this.repository.getProjectDetail(project.id);
          if (!afterVoice) {
            continue;
          }
          await this.repository.setProjectStatus(project.id, "visual_rendering", "Visual render worker started.");
          await this.visualWorker.renderProject(afterVoice);
          await this.repository.markAssetsReadyIfComplete(project.id);
          summary.processedProjects += 1;
          continue;
        }

        if (project.status === "assets_ready") {
          await this.repository.enqueueComposition(project.id);
          const readyProject = await this.repository.getProjectDetail(project.id);
          if (readyProject) {
            await this.composerWorker.compose(readyProject);
            summary.processedProjects += 1;
          }
          continue;
        }

        if (project.status === "composing") {
          await this.composerWorker.compose(project);
          summary.processedProjects += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.failProject(projectSummary.id, message);
        summary.failures.push({
          projectId: projectSummary.id,
          message
        });
      }
    }

    return summary;
  }

  private async shouldTriggerWeeklyTopics() {
    const config = getAppConfig();
    const now = new Date();
    if (now.getDay() !== config.videoWeeklyTopicDay || now.getHours() !== config.videoWeeklyTopicHour) {
      return false;
    }
    return !(await this.repository.hasRecentWeeklyBatch());
  }
}
