import type {
  AccountListItem,
  AccountStatusView,
  ArtifactSummary,
  DashboardSummary,
  DraftListItem,
  ImageAssetReanalyzeProgress,
  ImageAssetCandidate,
  ImageAssetDetail,
  ImageAssetUsageRecord,
  ImageImportJobSummary,
  JobDetail,
  JobListItem,
  ModelCenterView,
  OpsIncidentDetail,
  OpsIncidentSummary,
  OpsScanSummary,
  OpsSummary,
  PromptSetName,
  PromptSetView,
  PublishAttemptSummary,
  ScheduleSlot,
  SkillRunSummary,
  ToolTraceSummary,
  TopicBatchPlan,
  TopicListItem,
  VideoFeedbackDocumentSummary,
  VideoHubSummary,
  VideoProjectDetail,
  VideoProjectSummary,
  VideoScriptPack,
  VideoTargetPlatform,
  VideoTopicBatchSummary,
  VideoTopicCandidateSummary,
  VisualRenderPlan,
  ZhihuNoteAgentApplyInput,
  ZhihuNoteAgentApplyResult,
  ZhihuNoteAgentDraft,
  ZhihuNoteAgentGenerateInput,
  UpdateModelCenterInput,
  UpdateImageAssetInput,
  WorkerTickSummary
} from "@zhihu-mvp/shared";
import { buildNetworkErrorMessage } from "./http";

// 服务端请求使用 INTERNAL_API_BASE_URL，浏览器请求使用 NEXT_PUBLIC_API_BASE_URL
const INTERNAL_API_BASE_URL =
  process.env.INTERNAL_API_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://127.0.0.1:8787";

const CLIENT_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

const INTERNAL_CONTROL_API_BASE_URL =
  process.env.INTERNAL_CONTROL_API_BASE_URL ??
  process.env.CONTROL_API_URL ??
  process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL ??
  "http://127.0.0.1:8790";

const CLIENT_CONTROL_API_BASE_URL =
  process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL ?? "/control-api";

const INTERNAL_IMAGE_API_BASE_URL = INTERNAL_CONTROL_API_BASE_URL;
const CLIENT_IMAGE_API_BASE_URL = CLIENT_CONTROL_API_BASE_URL;

declare global {
  interface Window {
    __ZHIHU_MVP_API_BASE_URL__?: string;
    __ZHIHU_MVP_IMAGE_API_BASE_URL__?: string;
    __ZHIHU_MVP_CONTROL_API_BASE_URL__?: string;
  }
}

export type CreateJobResponse = {
  jobId: number;
  status: string;
  displayStatus: string;
  currentStage: string | null;
  scheduledAt: string | null;
  message: string;
};

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  // 服务端使用内部地址，浏览器使用代理路径
  const baseUrl = typeof window !== "undefined" ? CLIENT_API_BASE_URL : INTERNAL_API_BASE_URL;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      cache: "no-store"
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("Dynamic server usage") || error.message.includes("Route /"))
    ) {
      throw error;
    }

    throw new Error(buildNetworkErrorMessage(path, error));
  }

  const text = await response.text();
  const payload = safeParseRecord(text);

  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "object" && payload.error && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message ?? "")
        : text || `Request failed: ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

async function imageApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  const baseUrl = typeof window !== "undefined" ? getClientImageApiBaseUrl() : INTERNAL_IMAGE_API_BASE_URL;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(buildNetworkErrorMessage(path, error, baseUrl));
  }

  const text = await response.text();
  const payload = safeParseRecord(text);

  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "object" && payload.error && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message ?? "")
        : text || `Request failed: ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

async function controlApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  const baseUrl = typeof window !== "undefined" ? getClientControlApiBaseUrl() : INTERNAL_CONTROL_API_BASE_URL;

  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(buildNetworkErrorMessage(path, error, baseUrl));
  }

  const text = await response.text();
  const payload = safeParseRecord(text);

  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "object" && payload.error && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message ?? "")
        : text || `Request failed: ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export async function getDashboardSummary() {
  const data = await apiFetch<{ summary: DashboardSummary }>(buildPathWithAccountId("/dashboard/summary"));
  return data.summary;
}

export async function getTodaySchedule() {
  const data = await apiFetch<{ slots: ScheduleSlot[] }>("/schedule/today");
  return data.slots;
}

export async function getWeekSchedule() {
  const data = await apiFetch<{ slots: ScheduleSlot[] }>("/schedule/week");
  return data.slots;
}

export async function getTopics(accountId?: number | null) {
  const data = await apiFetch<{ topics: TopicListItem[] }>(buildPathWithAccountId("/topics", accountId));
  return data.topics;
}

export async function getTopicBatchPlan(accountId?: number | null) {
  const data = await apiFetch<{ plan: TopicBatchPlan }>(buildPathWithAccountId("/topics/batch-plan", accountId));
  return data.plan;
}

export async function getDrafts(accountId?: number | null) {
  const data = await apiFetch<{ drafts: DraftListItem[] }>(buildPathWithAccountId("/drafts", accountId));
  return data.drafts;
}

export async function getJobs() {
  const data = await apiFetch<{ jobs: JobListItem[] }>("/jobs");
  return data.jobs;
}

export async function getPublishJobs() {
  const data = await apiFetch<{ jobs: JobListItem[] }>("/publish-jobs");
  return data.jobs;
}

export async function getJob(jobId: number) {
  const data = await apiFetch<{ job: JobDetail | null }>(`/jobs/${jobId}`);
  return data.job;
}

export async function getJobAttempts(jobId: number) {
  const data = await apiFetch<{ attempts: PublishAttemptSummary[] }>(`/jobs/${jobId}/publish-attempts`);
  return data.attempts;
}

export async function getJobArtifacts(jobId: number) {
  const data = await apiFetch<{ artifacts: ArtifactSummary[] }>(`/jobs/${jobId}/artifacts`);
  return data.artifacts;
}

export async function getJobToolTraces(jobId: number) {
  const data = await apiFetch<{ traces: ToolTraceSummary[] }>(`/jobs/${jobId}/tool-traces`);
  return data.traces;
}

export async function getJobSkillRuns(jobId: number) {
  const data = await apiFetch<{ skillRuns: SkillRunSummary[] }>(`/jobs/${jobId}/skill-runs`);
  return data.skillRuns;
}

export async function getDashboardSummaryForAccount(accountId?: number | null) {
  const data = await apiFetch<{ summary: DashboardSummary }>(buildPathWithAccountId("/dashboard/summary", accountId));
  return data.summary;
}

export async function getAccounts() {
  const data = await apiFetch<{ accounts: AccountListItem[] }>("/accounts");
  return data.accounts;
}

export async function getAccountStatus(accountId?: number | null) {
  const data = await apiFetch<{ account: AccountStatusView | null }>(buildPathWithAccountId("/account/status", accountId));
  return data.account;
}

export async function getPromptSets() {
  const data = await apiFetch<{ promptSets: PromptSetView[] }>("/prompt-sets");
  return data.promptSets;
}

export async function getPromptSet(name: PromptSetName) {
  const data = await apiFetch<{ promptSet: PromptSetView | null }>(`/prompt-sets/${name}`);
  return data.promptSet;
}

export async function getModelCenterConfig() {
  const data = await controlApiFetch<{ modelCenter: ModelCenterView }>("/model-center");
  return data.modelCenter;
}

export async function updateModelCenterConfig(input: UpdateModelCenterInput) {
  const data = await postControlJson<{ ok: boolean; modelCenter: ModelCenterView }>("/model-center", input, "PUT");
  return data.modelCenter;
}

export async function postJson<T>(path: string, body?: unknown, method = "POST") {
  return apiFetch<T>(path, {
    method,
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function postImageJson<T>(path: string, body?: unknown, method = "POST") {
  return imageApiFetch<T>(path, {
    method,
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function postControlJson<T>(path: string, body?: unknown, method = "POST") {
  return controlApiFetch<T>(path, {
    method,
    body: body ? JSON.stringify(body) : undefined
  });
}

export async function getVideoHubSummary() {
  const data = await apiFetch<{ summary: VideoHubSummary }>("/video-hub/summary");
  return data.summary;
}

export async function getVideoTopicBatches() {
  const data = await apiFetch<{ batches: VideoTopicBatchSummary[] }>("/video-hub/topic-batches");
  return data.batches;
}

export async function createVideoTopicBatch(input: {
  source?: "weekly" | "hotspot" | "manual" | "platform_request" | "refill";
  targetPlatform?: VideoTargetPlatform;
  targetCount?: number;
  productBrief?: string;
  audience?: string;
  userRequirement?: string;
}) {
  const data = await postJson<{ batch: VideoTopicBatchSummary | null }>("/video-hub/topic-batches", input);
  return data.batch;
}

export async function refillVideoTopicBatch(batchId: string, input?: { targetCount?: number; userRequirement?: string }) {
  const data = await postJson<{ batch: VideoTopicBatchSummary | null }>(`/video-hub/topic-batches/${batchId}/refill`, input ?? {});
  return data.batch;
}

export async function getVideoTopicCandidates(batchId?: string | null) {
  const data = await apiFetch<{ candidates: VideoTopicCandidateSummary[] }>(
    `/video-hub/topic-candidates${buildQueryString({ batchId })}`
  );
  return data.candidates;
}

export async function saveVideoTopicFeedback(
  candidateId: string,
  input: {
    decision: "hit" | "miss" | "not_now" | "duplicate" | "risky";
    reason?: string;
    suggestion?: string;
  }
) {
  const data = await postJson<{ candidate: VideoTopicCandidateSummary | null }>(
    `/video-hub/topic-candidates/${candidateId}/feedback`,
    input
  );
  return data.candidate;
}

export async function scoreVideoHotspot(input: {
  hotspot: Record<string, unknown>;
  productBrief?: string;
  audience?: string;
  targetPlatform?: VideoTargetPlatform;
}) {
  const data = await postJson<{
    result: {
      topicFitScore: number;
      productionScore: number;
      score: number;
      reason: string;
      accepted: boolean;
      batchId: string | null;
    };
  }>("/video-hub/hotspots/score", input);
  return data.result;
}

export async function createVideoProject(input: { topicCandidateId: string; title?: string }) {
  const data = await postJson<{ project: VideoProjectSummary | null }>("/video-hub/projects", input);
  return data.project;
}

export async function getVideoProjects() {
  const data = await apiFetch<{ projects: VideoProjectSummary[] }>("/video-hub/projects");
  return data.projects;
}

export async function getVideoProject(projectId: string) {
  const data = await apiFetch<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}`);
  return data.project;
}

export async function generateVideoScript(projectId: string, revisionInstruction = "") {
  const data = await postJson<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}/script/generate`, {
    revisionInstruction
  });
  return data.project;
}

export async function saveVideoScript(projectId: string, scriptPack: VideoScriptPack) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(
    `/video-hub/projects/${projectId}/script`,
    { scriptPack },
    "PUT"
  );
  return data.project;
}

export async function confirmVideoScript(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}/script/confirm`, {});
  return data.project;
}

export async function generateVideoRenderPlan(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(
    `/video-hub/projects/${projectId}/render-plan/generate`,
    {}
  );
  return data.project;
}

export async function saveVideoRenderPlan(projectId: string, visualRenderPlan: VisualRenderPlan) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(
    `/video-hub/projects/${projectId}/render-plan`,
    { visualRenderPlan },
    "PUT"
  );
  return data.project;
}

export async function confirmVideoRenderPlan(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(
    `/video-hub/projects/${projectId}/render-plan/confirm`,
    {}
  );
  return data.project;
}

export async function enqueueVideoAssets(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}/assets/enqueue`, {});
  return data.project;
}

export async function enqueueVideoComposition(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}/compose`, {});
  return data.project;
}

export async function approveVideoProject(projectId: string) {
  const data = await postJson<{ project: VideoProjectDetail | null }>(`/video-hub/projects/${projectId}/approve`, {});
  return data.project;
}

export function getVideoAssetContentUrl(assetId: string) {
  const baseUrl =
    typeof window !== "undefined" && window.__ZHIHU_MVP_API_BASE_URL__
      ? window.__ZHIHU_MVP_API_BASE_URL__
      : CLIENT_API_BASE_URL;
  return `${baseUrl}/video-hub/assets/${assetId}/content`;
}

export async function createVideoFeedbackDocument(input: {
  scope?: "global" | "topic" | "writer" | "visual" | "project";
  projectId?: string | null;
  notes?: string;
}) {
  const data = await postJson<{ document: { id: string; markdown: string; filePath?: string } }>(
    "/video-hub/feedback-documents",
    input
  );
  return data.document;
}

export async function createJob(accountId: number) {
  return postJson<CreateJobResponse>("/jobs", { accountId });
}

export async function retryJob(jobId: number) {
  return postJson<{ ok: true }>(`/jobs/${jobId}/retry`, {});
}

export async function reselectTopic(jobId: number) {
  return postJson<{ ok: true }>(`/jobs/${jobId}/reselect-topic`, {});
}

export async function generateZhihuNoteAgentDraft(accountId: number, input: ZhihuNoteAgentGenerateInput) {
  const data = await postJson<{ draft: ZhihuNoteAgentDraft }>(`/accounts/${accountId}/note-agent/generate`, input);
  return data.draft;
}

export async function applyZhihuNoteAgentDraft(accountId: number, input: ZhihuNoteAgentApplyInput) {
  const data = await postJson<{ ok: boolean; result: ZhihuNoteAgentApplyResult }>(
    `/accounts/${accountId}/note-agent/apply`,
    input
  );
  return data.result;
}

export async function runWorkerTick() {
  const data = await postJson<{ summary: WorkerTickSummary }>("/worker/tick");
  return data.summary;
}

export async function getOpsSummary() {
  const data = await apiFetch<{ summary: OpsSummary }>("/ops/summary");
  return data.summary;
}

export async function getOpsIncidents() {
  const data = await apiFetch<{ incidents: OpsIncidentSummary[] }>("/ops/incidents");
  return data.incidents;
}

export async function getOpsIncident(id: number) {
  const data = await apiFetch<{ incident: OpsIncidentDetail | null }>(`/ops/incidents/${id}`);
  return data.incident;
}

export async function runOpsScan() {
  const data = await postJson<{ summary: OpsScanSummary }>("/ops/scan");
  return data.summary;
}

export async function getImageAssets(filters: {
  query?: string;
  anchorKeyword?: string;
  entity?: string;
  platformScope?: string;
  platform?: string;
  assetType?: string;
  usageScope?: string;
  hasText?: string;
  aspectRatio?: string;
  riskLevel?: string;
  status?: string;
  limit?: number;
}) {
  const data = await imageApiFetch<{ items: ImageAssetCandidate[] }>(`/image-assets${buildQueryString(filters)}`);
  return data.items;
}

export async function getImageAsset(id: string) {
  const data = await imageApiFetch<{ asset: ImageAssetDetail | null }>(`/image-assets/${id}`);
  return data.asset;
}

export async function getImageAssetDetail(id: string) {
  const data = await imageApiFetch<{ asset: ImageAssetDetail | null; usageRecords: ImageAssetUsageRecord[] }>(
    `/image-assets/${id}`
  );
  return data;
}

export async function getImageImportJobs() {
  const data = await imageApiFetch<{ jobs: ImageImportJobSummary[] }>("/image-assets/import-jobs");
  return data.jobs;
}

export async function getImageImportJob(id: string) {
  const data = await imageApiFetch<{ job: ImageImportJobSummary | null }>(`/image-assets/import-jobs/${id}`);
  return data.job;
}

export async function createImageImportJob(sourcePath: string) {
  const data = await postImageJson<{ ok: boolean; job: ImageImportJobSummary | null }>("/image-assets/import-jobs", {
    sourcePath,
    sourceType: "directory"
  });
  return data.job;
}

export async function updateImageAsset(id: string, input: UpdateImageAssetInput) {
  const data = await postImageJson<{ ok: boolean; asset: ImageAssetDetail | null }>(`/image-assets/${id}`, input, "PATCH");
  return data.asset;
}

export async function reanalyzeImageAsset(id: string) {
  const data = await postImageJson<{ ok: boolean; asset: ImageAssetDetail | null }>(`/image-assets/${id}/analyze`, {});
  return data.asset;
}

export async function reanalyzeImageAssets(input?: {
  status?: "pending_review" | "active" | "disabled" | "rejected" | "all";
  limit?: number;
}) {
  const data = await postImageJson<{
    ok: boolean;
    progress: ImageAssetReanalyzeProgress;
  }>("/image-assets/reanalyze", input ?? {});
  return data.progress;
}

export async function getImageAssetReanalyzeProgress() {
  const data = await imageApiFetch<{ progress: ImageAssetReanalyzeProgress }>("/image-assets/reanalyze/status");
  return data.progress;
}

export async function pauseImageAssetReanalyze() {
  const data = await postImageJson<{ ok: boolean; progress: ImageAssetReanalyzeProgress }>("/image-assets/reanalyze/pause", {});
  return data.progress;
}

export async function resumeImageAssetReanalyze() {
  const data = await postImageJson<{ ok: boolean; progress: ImageAssetReanalyzeProgress }>("/image-assets/reanalyze/resume", {});
  return data.progress;
}

export async function suggestImageAssets(input: {
  query?: string;
  platform?: "zhihu" | "x";
  assetType?: string;
  hasText?: boolean;
  aspectRatio?: string;
  riskLevel?: string;
  limit?: number;
}) {
  const data = await postImageJson<{ items: ImageAssetCandidate[] }>("/image-assets/suggest", input);
  return data.items;
}

export async function getImageUsageRecords(filter?: {
  assetId?: string;
  taskId?: string;
  platform?: "zhihu" | "x";
  limit?: number;
}) {
  const data = await imageApiFetch<{ records: ImageAssetUsageRecord[] }>(`/image-assets/usage-records${buildQueryString(filter)}`);
  return data.records;
}

export async function bindZhihuJobImage(
  jobId: number,
  input: {
    assetId: string | null;
    usageType?: "cover" | "body_image" | "reaction" | "preview";
    note?: string | null;
  }
) {
  return postImageJson<{
    ok: boolean;
    job: JobDetail | null;
    asset: ImageAssetDetail | null;
    usageRecord: ImageAssetUsageRecord | null;
  }>(`/bindings/zhihu-jobs/${jobId}/image`, input);
}

function safeParseRecord(text: string) {
  if (!text) {
    return {} as Record<string, unknown>;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function getClientImageApiBaseUrl() {
  if (typeof window !== "undefined" && window.__ZHIHU_MVP_IMAGE_API_BASE_URL__) {
    return window.__ZHIHU_MVP_IMAGE_API_BASE_URL__;
  }

  return CLIENT_IMAGE_API_BASE_URL;
}

function getClientControlApiBaseUrl() {
  if (typeof window !== "undefined" && window.__ZHIHU_MVP_CONTROL_API_BASE_URL__) {
    return window.__ZHIHU_MVP_CONTROL_API_BASE_URL__;
  }

  return CLIENT_CONTROL_API_BASE_URL;
}

function buildPathWithAccountId(path: string, accountId?: number | null) {
  if (!accountId) {
    return path;
  }

  const searchParams = new URLSearchParams({
    accountId: String(accountId)
  });

  return `${path}?${searchParams.toString()}`;
}

function buildQueryString(values?: Record<string, unknown>) {
  if (!values) {
    return "";
  }

  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}
