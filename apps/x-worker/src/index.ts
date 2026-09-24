import {
  getXAppConfig,
  XHotspotScoutService,
  XMainAgentService,
  XNotificationService,
  XPublisherService,
  XPromptService,
  XReviewAgentService,
  XWorkspaceRepository,
  XWorkerRunner,
  XWriterService,
  XLlmService
} from "@zhihu-mvp/x-core";

const repository = new XWorkspaceRepository();
const llmService = new XLlmService();
const promptService = new XPromptService(llmService);
const writerService = new XWriterService(llmService);
const reviewAgentService = new XReviewAgentService(llmService);
const mainAgentService = new XMainAgentService(llmService);
const publisherService = new XPublisherService();
const notificationService = new XNotificationService();
const hotspotScoutService = new XHotspotScoutService(llmService);
const runner = new XWorkerRunner(
  repository,
  llmService,
  writerService,
  reviewAgentService,
  mainAgentService,
  hotspotScoutService,
  publisherService,
  notificationService
);

let timer: NodeJS.Timeout | null = null;
let stopped = false;

async function boot() {
  await repository.ensureReady();
  await promptService.bootstrapDefaults();
  await hotspotScoutService.ensureReady();

  const loop = async () => {
    if (stopped) {
      return;
    }

    try {
      const summary = await runner.tick();
      console.log("[x-worker] tick", JSON.stringify(summary));
      const hotspotSummary = await hotspotScoutService.tick();
      console.log("[x-worker] hotspot_tick", JSON.stringify(hotspotSummary));
    } catch (error) {
      console.error("[x-worker] tick failed", error);
    } finally {
      if (!stopped) {
        timer = setTimeout(loop, getXAppConfig().workerIntervalMs);
      }
    }
  };

  await loop();
}

async function shutdown() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
  }
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

await boot();
