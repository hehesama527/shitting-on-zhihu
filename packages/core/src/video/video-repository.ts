import crypto from "node:crypto";
import type {
  VideoAssetStatus,
  VideoAssetSummary,
  VideoAssetType,
  VideoCaseAssumptions,
  VideoCaseDataSource,
  VideoCaseIntentRequest,
  VideoCaseIntentStatus,
  VideoCaseIntentSummary,
  VideoCaseStrategyConfig,
  VideoCaseStrategyName,
  VideoFeedbackDocumentSummary,
  VideoProjectDetail,
  VideoProjectSegmentSummary,
  VideoProjectStatus,
  VideoProjectSummary,
  VideoRenderBuilder,
  VideoScriptPack,
  VideoSegmentStatus,
  VideoTargetPlatform,
  VideoTopicBatchOutput,
  VideoTopicBatchSummary,
  VideoTopicCandidateInput,
  VideoTopicCandidateStatus,
  VideoTopicCandidateSummary,
  VideoTopicFeedbackDecision,
  VideoTopicSource,
  VideoVerifiedCasePack,
  VideoVerifiedCasePackStatus,
  VideoVerifiedCasePackSummary,
  VisualRenderPlan
} from "@zhihu-mvp/shared";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { safeParseJson } from "../utils/json.js";
import { assertVideoProjectTransition } from "./video-state.js";

type BatchRow = RowDataPacket & {
  id: string;
  source: VideoTopicSource;
  status: "pending_feedback" | "completed" | "failed";
  target_platform: VideoTargetPlatform;
  target_count: number;
  generated_count: number;
  selected_count: number;
  summary: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type CandidateRow = RowDataPacket & {
  id: string;
  batch_id: string;
  source: VideoTopicSource;
  target_platform: VideoTargetPlatform;
  title: string;
  brief: string;
  angle: string;
  video_format: VideoTopicCandidateInput["videoFormat"];
  target_audience: string;
  why_this: string;
  estimated_duration_sec: number | null;
  score: number;
  topic_fit_score: number | null;
  production_score: number | null;
  score_breakdown_json: string | null;
  risk_notes_json: string | null;
  source_refs_json: string | null;
  status: VideoTopicCandidateStatus;
  latest_feedback_decision?: VideoTopicFeedbackDecision | null;
  created_at: Date;
  updated_at: Date;
};

type ProjectRow = RowDataPacket & {
  id: string;
  topic_candidate_id: string;
  title: string;
  status: VideoProjectStatus;
  target_platform: VideoTargetPlatform;
  aspect_ratio: "16:9";
  target_duration_sec: number | null;
  script_pack_json: string | null;
  visual_render_plan_json: string | null;
  script_confirmed_at: Date | null;
  visual_render_plan_confirmed_at: Date | null;
  final_video_asset_id: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type SegmentRow = RowDataPacket & {
  id: string;
  project_id: string;
  segment_key: string;
  segment_order: number;
  title: string;
  voiceover: string;
  subtitle: string;
  image_prompt: string;
  visual_builder: VideoRenderBuilder | null;
  duration_sec: number;
  status: VideoSegmentStatus;
  error_message: string | null;
  updated_at: Date;
};

type AssetRow = RowDataPacket & {
  id: string;
  project_id: string;
  segment_id: string | null;
  asset_type: VideoAssetType;
  status: VideoAssetStatus;
  builder: VideoRenderBuilder | null;
  file_path: string | null;
  public_url: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  attempt_no: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type CaseIntentRow = RowDataPacket & {
  id: string;
  project_id: string;
  status: VideoCaseIntentStatus;
  data_source: VideoCaseDataSource;
  symbol: string;
  kline_interval: string;
  collection_name: string | null;
  start_time: Date;
  end_time: Date;
  strategy_name: VideoCaseStrategyName;
  strategy_params_json: string;
  assumptions_json: string;
  request_json: string;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type VerifiedCasePackRow = RowDataPacket & {
  id: string;
  project_id: string;
  case_intent_id: string;
  case_id: string;
  status: VideoVerifiedCasePackStatus;
  data_source_json: string;
  strategy_json: string;
  metrics_json: string;
  review_json: string;
  chart_data_json: string;
  pack_json: string;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
};

type FeedbackDocRow = RowDataPacket & {
  id: string;
  scope: VideoFeedbackDocumentSummary["scope"];
  markdown: string;
  summary_json: string | null;
  created_at: Date;
};

export type CreateVideoTopicBatchRecordInput = {
  source: VideoTopicSource;
  targetPlatform: VideoTargetPlatform;
  targetCount: number;
  input: unknown;
  output: VideoTopicBatchOutput;
};

export type CreateVideoAssetInput = {
  projectId: string;
  segmentId?: string | null;
  assetType: VideoAssetType;
  status?: VideoAssetStatus;
  builder?: VideoRenderBuilder | null;
  filePath?: string | null;
  publicUrl?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown> | null;
  errorMessage?: string | null;
  replaceSegmentVisuals?: boolean;
};

export type CreateVideoVerifiedCasePackInput = {
  projectId: string;
  caseIntentId: string;
  pack: VideoVerifiedCasePack;
  errorMessage?: string | null;
};

export class VideoRepository {
  constructor(private readonly pool: Pool) {}

  async createTopicBatch(input: CreateVideoTopicBatchRecordInput) {
    const batchId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_topic_batches (
         id, source, status, target_platform, target_count, generated_count, summary, input_json, output_json
       ) VALUES (?, ?, 'pending_feedback', ?, ?, ?, ?, ?, ?)`,
      [
        batchId,
        input.source,
        input.targetPlatform,
        input.targetCount,
        input.output.candidates.length,
        input.output.summary,
        JSON.stringify(input.input),
        JSON.stringify(input.output)
      ]
    );

    for (const candidate of input.output.candidates) {
      await this.insertCandidate(batchId, input.source, input.targetPlatform, candidate);
    }

    return this.getTopicBatch(batchId);
  }

  async insertCandidate(
    batchId: string,
    source: VideoTopicSource,
    targetPlatform: VideoTargetPlatform,
    candidate: VideoTopicCandidateInput
  ) {
    const candidateId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_topic_candidates (
         id, batch_id, source, target_platform, title, brief, angle, video_format, target_audience, why_this,
         estimated_duration_sec, score, topic_fit_score, production_score, score_breakdown_json, risk_notes_json,
         source_refs_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidateId,
        batchId,
        source,
        targetPlatform,
        candidate.title,
        candidate.brief,
        candidate.angle,
        candidate.videoFormat,
        candidate.targetAudience,
        candidate.whyThis,
        candidate.estimatedDurationSec ?? null,
        candidate.score,
        candidate.topicFitScore ?? null,
        candidate.productionScore ?? null,
        JSON.stringify(candidate.scoreBreakdown ?? {}),
        JSON.stringify(candidate.riskNotes ?? []),
        JSON.stringify(candidate.sourceRefs ?? [])
      ]
    );
    return candidateId;
  }

  async getTopicBatch(batchId: string) {
    const [rows] = await this.pool.query<BatchRow[]>("SELECT * FROM video_topic_batches WHERE id = ?", [batchId]);
    return rows[0] ? mapBatch(rows[0]) : null;
  }

  async listTopicBatches(limit = 20) {
    const [rows] = await this.pool.query<BatchRow[]>(
      "SELECT * FROM video_topic_batches ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map(mapBatch);
  }

  async hasRecentWeeklyBatch(days = 6) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count
       FROM video_topic_batches
       WHERE source = 'weekly' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  async listTopicCandidates(limit = 50, batchId?: string | null) {
    const params: unknown[] = [];
    const where = batchId ? "WHERE c.batch_id = ?" : "";
    if (batchId) {
      params.push(batchId);
    }
    params.push(limit);
    const [rows] = await this.pool.query<CandidateRow[]>(
      `SELECT c.*,
              (SELECT f.decision FROM video_topic_feedback f WHERE f.candidate_id = c.id ORDER BY f.created_at DESC LIMIT 1)
                AS latest_feedback_decision
       FROM video_topic_candidates c
       ${where}
       ORDER BY c.created_at DESC
       LIMIT ?`,
      params
    );
    return rows.map(mapCandidate);
  }

  async getTopicCandidate(candidateId: string) {
    const [rows] = await this.pool.query<CandidateRow[]>(
      `SELECT c.*,
              (SELECT f.decision FROM video_topic_feedback f WHERE f.candidate_id = c.id ORDER BY f.created_at DESC LIMIT 1)
                AS latest_feedback_decision
       FROM video_topic_candidates c
       WHERE c.id = ?`,
      [candidateId]
    );
    return rows[0] ? mapCandidate(rows[0]) : null;
  }

  async saveTopicFeedback(input: {
    candidateId: string;
    decision: VideoTopicFeedbackDecision;
    reason?: string;
    suggestion?: string;
  }) {
    const candidate = await this.getTopicCandidate(input.candidateId);
    if (!candidate) {
      throw new Error("Video topic candidate not found.");
    }

    const feedbackId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_topic_feedback (id, candidate_id, batch_id, decision, reason, suggestion)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        feedbackId,
        input.candidateId,
        candidate.batchId,
        input.decision,
        input.reason ?? null,
        input.suggestion ?? null
      ]
    );

    const nextStatus = feedbackDecisionToCandidateStatus(input.decision);
    await this.pool.query("UPDATE video_topic_candidates SET status = ? WHERE id = ?", [nextStatus, input.candidateId]);
    await this.refreshBatchSelectedCount(candidate.batchId);
    return this.getTopicCandidate(input.candidateId);
  }

  async createProjectFromCandidate(candidateId: string, title?: string | null) {
    const candidate = await this.getTopicCandidate(candidateId);
    if (!candidate) {
      throw new Error("Video topic candidate not found.");
    }
    if (candidate.status !== "selected" && candidate.latestFeedbackDecision !== "hit") {
      throw new Error("Only selected video topics can create projects.");
    }

    const projectId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_projects (id, topic_candidate_id, title, status, target_platform, aspect_ratio, target_duration_sec)
       VALUES (?, ?, ?, 'topic_selected', ?, '16:9', ?)`,
      [projectId, candidateId, title?.trim() || candidate.title, candidate.targetPlatform, candidate.estimatedDurationSec ?? null]
    );
    await this.pool.query("UPDATE video_topic_candidates SET status = 'project_created' WHERE id = ?", [candidateId]);
    await this.addEvent(projectId, "project_created", null, "topic_selected", "Video project created from selected topic.");
    return this.getProject(projectId);
  }

  async listProjects(limit = 50) {
    const [rows] = await this.pool.query<ProjectRow[]>(
      "SELECT * FROM video_projects ORDER BY updated_at DESC LIMIT ?",
      [limit]
    );
    return rows.map(mapProject);
  }

  async getProject(projectId: string) {
    const [rows] = await this.pool.query<ProjectRow[]>("SELECT * FROM video_projects WHERE id = ?", [projectId]);
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async getProjectDetail(projectId: string): Promise<VideoProjectDetail | null> {
    const [rows] = await this.pool.query<ProjectRow[]>("SELECT * FROM video_projects WHERE id = ?", [projectId]);
    const row = rows[0];
    if (!row) {
      return null;
    }

    const project = mapProject(row);
    const [segments, assets, topic, caseIntents, verifiedCasePacks] = await Promise.all([
      this.listProjectSegments(projectId),
      this.listProjectAssets(projectId),
      this.getTopicCandidate(project.topicCandidateId),
      this.listProjectCaseIntents(projectId),
      this.listProjectVerifiedCasePacks(projectId)
    ]);

    return {
      ...project,
      topic,
      scriptPack: row.script_pack_json ? safeParseJson<VideoScriptPack | null>(row.script_pack_json, null) : null,
      visualRenderPlan: row.visual_render_plan_json
        ? safeParseJson<VisualRenderPlan | null>(row.visual_render_plan_json, null)
        : null,
      segments,
      assets,
      caseIntents,
      verifiedCasePacks
    };
  }

  async createCaseIntent(projectId: string, input: VideoCaseIntentRequest) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }

    const strategyParams: VideoCaseStrategyConfig = {
      name: input.strategy?.name ?? "sma_crossover",
      fastWindow: input.strategy?.fastWindow ?? 20,
      slowWindow: input.strategy?.slowWindow ?? 60,
      side: input.strategy?.side ?? "long_only"
    };
    const assumptions: VideoCaseAssumptions = {
      initialCapital: input.assumptions?.initialCapital ?? 10_000,
      feeBpsEachSide: input.assumptions?.feeBpsEachSide ?? 10,
      slippageBpsEachSide: input.assumptions?.slippageBpsEachSide ?? 5
    };
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_case_intents (
         id, project_id, status, data_source, symbol, kline_interval, collection_name, start_time, end_time,
         strategy_name, strategy_params_json, assumptions_json, request_json
       ) VALUES (?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        input.dataSource ?? "cryptopathx_mongo",
        input.symbol,
        input.interval,
        input.collectionName ?? null,
        new Date(input.startTime),
        new Date(input.endTime),
        strategyParams.name,
        JSON.stringify(strategyParams),
        JSON.stringify(assumptions),
        JSON.stringify(input)
      ]
    );
    await this.addEvent(projectId, "case_intent_created", project.status, project.status, "Video case intent created.", {
      caseIntentId: id,
      symbol: input.symbol,
      interval: input.interval
    });
    return this.getCaseIntent(id);
  }

  async getCaseIntent(caseIntentId: string) {
    const [rows] = await this.pool.query<CaseIntentRow[]>("SELECT * FROM video_case_intents WHERE id = ?", [
      caseIntentId
    ]);
    return rows[0] ? mapCaseIntent(rows[0]) : null;
  }

  async listProjectCaseIntents(projectId: string) {
    const [rows] = await this.pool.query<CaseIntentRow[]>(
      "SELECT * FROM video_case_intents WHERE project_id = ? ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(mapCaseIntent);
  }

  async updateCaseIntentStatus(
    caseIntentId: string,
    status: VideoCaseIntentStatus,
    errorMessage?: string | null
  ) {
    await this.pool.query("UPDATE video_case_intents SET status = ?, error_message = ? WHERE id = ?", [
      status,
      errorMessage ?? null,
      caseIntentId
    ]);
  }

  async createVerifiedCasePack(input: CreateVideoVerifiedCasePackInput) {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_verified_case_packs (
         id, project_id, case_intent_id, case_id, status, data_source_json, strategy_json,
         metrics_json, review_json, chart_data_json, pack_json, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.caseIntentId,
        input.pack.caseId,
        input.pack.status,
        JSON.stringify(input.pack.dataSource),
        JSON.stringify(input.pack.strategy),
        JSON.stringify(input.pack.metrics),
        JSON.stringify(input.pack.review),
        JSON.stringify(input.pack.chartData),
        JSON.stringify(input.pack),
        input.errorMessage ?? null
      ]
    );
    await this.addEvent(
      input.projectId,
      "verified_case_pack_created",
      null,
      null,
      "Verified case pack created.",
      {
        caseIntentId: input.caseIntentId,
        casePackId: id,
        caseId: input.pack.caseId,
        status: input.pack.status
      }
    );
    return this.getVerifiedCasePack(id);
  }

  async getVerifiedCasePack(casePackId: string) {
    const [rows] = await this.pool.query<VerifiedCasePackRow[]>(
      "SELECT * FROM video_verified_case_packs WHERE id = ?",
      [casePackId]
    );
    return rows[0] ? mapVerifiedCasePack(rows[0]) : null;
  }

  async listProjectVerifiedCasePacks(projectId: string) {
    const [rows] = await this.pool.query<VerifiedCasePackRow[]>(
      "SELECT * FROM video_verified_case_packs WHERE project_id = ? ORDER BY created_at DESC",
      [projectId]
    );
    return rows.map(mapVerifiedCasePack);
  }

  async getLatestReadyVerifiedCasePack(projectId: string) {
    const [rows] = await this.pool.query<VerifiedCasePackRow[]>(
      `SELECT * FROM video_verified_case_packs
       WHERE project_id = ? AND status IN ('ready', 'ready_with_warnings')
       ORDER BY created_at DESC LIMIT 1`,
      [projectId]
    );
    return rows[0] ? mapVerifiedCasePack(rows[0]) : null;
  }

  async setProjectStatus(projectId: string, toStatus: VideoProjectStatus, message?: string | null) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    assertVideoProjectTransition(project.status, toStatus);
    await this.pool.query("UPDATE video_projects SET status = ?, error_message = NULL WHERE id = ?", [toStatus, projectId]);
    await this.addEvent(projectId, "status_changed", project.status, toStatus, message ?? null);
  }

  async failProject(projectId: string, message: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    await this.pool.query("UPDATE video_projects SET status = 'failed', error_message = ? WHERE id = ?", [message, projectId]);
    await this.addEvent(projectId, "project_failed", project.status, "failed", message);
  }

  async saveScriptPack(projectId: string, scriptPack: VideoScriptPack, pendingConfirmation = true) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }

    const nextStatus: VideoProjectStatus = pendingConfirmation ? "script_pending_confirmation" : project.status;
    assertVideoProjectTransition(project.status, nextStatus);
    await this.pool.query(
      `UPDATE video_projects
       SET title = ?, status = ?, target_duration_sec = ?, script_pack_json = ?, error_message = NULL
       WHERE id = ?`,
      [scriptPack.title, nextStatus, scriptPack.targetDurationSec, JSON.stringify(scriptPack), projectId]
    );
    await this.replaceSegmentsFromScript(projectId, scriptPack);
    await this.addEvent(projectId, "script_saved", project.status, nextStatus, "Video script pack saved.");
  }

  async confirmScriptPack(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    if (project.status !== "script_pending_confirmation" && project.status !== "render_plan_pending_confirmation") {
      throw new Error("Script can only be confirmed from script confirmation states.");
    }
    const nextStatus: VideoProjectStatus = project.status === "script_pending_confirmation"
      ? "render_plan_pending_confirmation"
      : "script_confirmed";
    await this.pool.query(
      "UPDATE video_projects SET status = ?, script_confirmed_at = COALESCE(script_confirmed_at, NOW()) WHERE id = ?",
      [nextStatus, projectId]
    );
    await this.pool.query("UPDATE video_project_segments SET status = 'script_confirmed' WHERE project_id = ?", [projectId]);
    await this.addEvent(projectId, "script_confirmed", project.status, nextStatus, "Script confirmed by user.");
  }

  async saveVisualRenderPlan(projectId: string, plan: VisualRenderPlan) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    await this.pool.query(
      `UPDATE video_projects
       SET status = 'render_plan_pending_confirmation',
           visual_render_plan_json = ?,
           visual_render_plan_confirmed_at = NULL
       WHERE id = ?`,
      [JSON.stringify(plan), projectId]
    );
    for (const segment of plan.segments) {
      await this.pool.query(
        `UPDATE video_project_segments
         SET visual_builder = ?, status = CASE WHEN status = 'script_confirmed' THEN 'visual_pending' ELSE status END
         WHERE project_id = ? AND segment_key = ?`,
        [segment.builder, projectId, segment.segmentId]
      );
    }
    await this.addEvent(projectId, "render_plan_saved", project.status, "render_plan_pending_confirmation", "Render plan saved.");
  }

  async confirmVisualRenderPlan(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    const detail = await this.getProjectDetail(projectId);
    if (!detail?.visualRenderPlan) {
      throw new Error("Visual render plan must be saved before confirmation.");
    }
    if (!project.scriptConfirmedAt) {
      throw new Error("Script must be confirmed before visual render plan confirmation.");
    }
    if (!project.visualRenderPlanConfirmedAt && project.status !== "render_plan_pending_confirmation" && project.status !== "script_confirmed") {
      throw new Error("Render plan is not ready for confirmation.");
    }
    await this.pool.query(
      `UPDATE video_projects
       SET status = 'script_confirmed', visual_render_plan_confirmed_at = COALESCE(visual_render_plan_confirmed_at, NOW())
       WHERE id = ?`,
      [projectId]
    );
    await this.addEvent(projectId, "render_plan_confirmed", project.status, "script_confirmed", "Render plan confirmed by user.");
  }

  async enqueueAssetProduction(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    if (!project.scriptConfirmedAt || !project.visualRenderPlanConfirmedAt) {
      throw new Error("Script and visual render plan must both be confirmed before asset production.");
    }
    assertVideoProjectTransition(project.status, "assets_pending");
    await this.pool.query("UPDATE video_projects SET status = 'assets_pending', error_message = NULL WHERE id = ?", [projectId]);
    await this.pool.query(
      `UPDATE video_project_segments
       SET status = CASE WHEN status IN ('script_confirmed', 'visual_pending') THEN 'voice_pending' ELSE status END
       WHERE project_id = ?`,
      [projectId]
    );
    await this.addEvent(projectId, "assets_enqueued", project.status, "assets_pending", "Asset production enqueued.");
  }

  async enqueueComposition(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    assertVideoProjectTransition(project.status, "composing");
    await this.pool.query("UPDATE video_projects SET status = 'composing', error_message = NULL WHERE id = ?", [projectId]);
    await this.addEvent(projectId, "composition_enqueued", project.status, "composing", "Composition enqueued.");
  }

  async approveProject(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    assertVideoProjectTransition(project.status, "approved");
    await this.pool.query("UPDATE video_projects SET status = 'approved' WHERE id = ?", [projectId]);
    await this.addEvent(projectId, "approved", project.status, "approved", "Final video approved.");
  }

  async listProjectSegments(projectId: string) {
    const [rows] = await this.pool.query<SegmentRow[]>(
      "SELECT * FROM video_project_segments WHERE project_id = ? ORDER BY segment_order ASC",
      [projectId]
    );
    return rows.map(mapSegment);
  }

  async updateSegmentStatus(segmentId: string, status: VideoSegmentStatus, errorMessage?: string | null) {
    await this.pool.query("UPDATE video_project_segments SET status = ?, error_message = ? WHERE id = ?", [
      status,
      errorMessage ?? null,
      segmentId
    ]);
  }

  async listProjectAssets(projectId: string) {
    const [rows] = await this.pool.query<AssetRow[]>(
      "SELECT * FROM video_assets WHERE project_id = ? ORDER BY created_at ASC",
      [projectId]
    );
    return rows.map(mapAsset);
  }

  async getAsset(assetId: string) {
    const [rows] = await this.pool.query<AssetRow[]>("SELECT * FROM video_assets WHERE id = ?", [assetId]);
    return rows[0] ? mapAsset(rows[0]) : null;
  }

  async getActiveAsset(projectId: string, segmentId: string | null, assetType: VideoAssetType) {
    const segmentClause = segmentId ? "segment_id = ?" : "segment_id IS NULL";
    const params = segmentId ? [projectId, segmentId, assetType] : [projectId, assetType];
    const [rows] = await this.pool.query<AssetRow[]>(
      `SELECT * FROM video_assets
       WHERE project_id = ? AND ${segmentClause} AND asset_type = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      params
    );
    return rows[0] ? mapAsset(rows[0]) : null;
  }

  async createAsset(input: CreateVideoAssetInput) {
    const [attemptRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS nextAttempt
       FROM video_assets
       WHERE project_id = ? AND ${input.segmentId ? "segment_id = ?" : "segment_id IS NULL"} AND asset_type = ?`,
      input.segmentId ? [input.projectId, input.segmentId, input.assetType] : [input.projectId, input.assetType]
    );
    const attemptNo = Number(attemptRows[0]?.nextAttempt ?? 1);

    if ((input.status ?? "active") === "active") {
      if (input.replaceSegmentVisuals && input.segmentId && isVideoVisualAssetType(input.assetType)) {
        await this.pool.query(
          `UPDATE video_assets
           SET status = 'superseded'
           WHERE project_id = ?
             AND segment_id = ?
             AND asset_type IN ('image', 'chart', 'text_card')
             AND status = 'active'`,
          [input.projectId, input.segmentId]
        );
      }
      await this.pool.query(
        `UPDATE video_assets
         SET status = 'superseded'
         WHERE project_id = ?
           AND ${input.segmentId ? "segment_id = ?" : "segment_id IS NULL"}
           AND asset_type = ?
           AND status = 'active'`,
        input.segmentId ? [input.projectId, input.segmentId, input.assetType] : [input.projectId, input.assetType]
      );
    }

    const assetId = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_assets (
         id, project_id, segment_id, asset_type, status, builder, file_path, public_url, mime_type,
         width, height, duration_ms, attempt_no, metadata_json, error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        input.projectId,
        input.segmentId ?? null,
        input.assetType,
        input.status ?? "active",
        input.builder ?? null,
        input.filePath ?? null,
        input.publicUrl ?? null,
        input.mimeType ?? null,
        input.width ?? null,
        input.height ?? null,
        input.durationMs ?? null,
        attemptNo,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.errorMessage ?? null
      ]
    );
    return assetId;
  }

  async markAssetsReadyIfComplete(projectId: string) {
    const segments = await this.listProjectSegments(projectId);
    const assets = await this.listProjectAssets(projectId);
    const activeAssets = assets.filter((asset) => asset.status === "active");

    for (const segment of segments) {
      const hasVoice = activeAssets.some((asset) => asset.segmentId === segment.id && asset.assetType === "voice");
      const hasVisual = activeAssets.some((asset) =>
        asset.segmentId === segment.id && ["image", "chart", "text_card"].includes(asset.assetType)
      );
      if (!hasVoice || !hasVisual) {
        return false;
      }
      await this.updateSegmentStatus(segment.id, "ready");
    }

    const project = await this.getProject(projectId);
    if (project && project.status !== "assets_ready") {
      await this.pool.query("UPDATE video_projects SET status = 'assets_ready' WHERE id = ?", [projectId]);
      await this.addEvent(projectId, "assets_ready", project.status, "assets_ready", "All segment assets are ready.");
    }
    return true;
  }

  async markVideoReady(projectId: string, finalAssetId: string) {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error("Video project not found.");
    }
    await this.pool.query(
      "UPDATE video_projects SET status = 'video_ready', final_video_asset_id = ?, error_message = NULL WHERE id = ?",
      [finalAssetId, projectId]
    );
    await this.addEvent(projectId, "video_ready", project.status, "video_ready", "Final video generated.");
  }

  async listProjectsForWorker(limit = 5) {
    const [rows] = await this.pool.query<ProjectRow[]>(
      `SELECT * FROM video_projects
       WHERE status IN ('assets_pending', 'assets_ready', 'composing')
       ORDER BY updated_at ASC LIMIT ?`,
      [limit]
    );
    return rows.map(mapProject);
  }

  async createFeedbackDocument(input: {
    scope: VideoFeedbackDocumentSummary["scope"];
    projectId?: string | null;
    markdown: string;
    summaryJson?: Record<string, unknown> | null;
    filePath?: string | null;
  }) {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO video_feedback_documents (id, scope, project_id, markdown, summary_json, file_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.scope,
        input.projectId ?? null,
        input.markdown,
        input.summaryJson ? JSON.stringify(input.summaryJson) : null,
        input.filePath ?? null
      ]
    );
    return id;
  }

  async listFeedbackDocuments(limit = 20) {
    const [rows] = await this.pool.query<FeedbackDocRow[]>(
      "SELECT * FROM video_feedback_documents ORDER BY created_at DESC LIMIT ?",
      [limit]
    );
    return rows.map(mapFeedbackDoc);
  }

  async addEvent(
    projectId: string,
    eventType: string,
    fromStatus: string | null,
    toStatus: string | null,
    message?: string | null,
    payload?: unknown
  ) {
    await this.pool.query(
      `INSERT INTO video_project_events (id, project_id, event_type, from_status, to_status, message, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), projectId, eventType, fromStatus, toStatus, message ?? null, payload ? JSON.stringify(payload) : null]
    );
  }

  private async replaceSegmentsFromScript(projectId: string, scriptPack: VideoScriptPack) {
    await this.pool.query("UPDATE video_project_segments SET status = 'superseded' WHERE project_id = ?", [projectId]);
    for (const segment of scriptPack.segments) {
      const id = crypto.randomUUID();
      await this.pool.query(
        `INSERT INTO video_project_segments (
           id, project_id, segment_key, segment_order, title, voiceover, subtitle, image_prompt, visual_intent,
           duration_sec, chart_spec_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'script_ready')
         ON DUPLICATE KEY UPDATE
           segment_order = VALUES(segment_order),
           title = VALUES(title),
           voiceover = VALUES(voiceover),
           subtitle = VALUES(subtitle),
           image_prompt = VALUES(image_prompt),
           visual_intent = VALUES(visual_intent),
           duration_sec = VALUES(duration_sec),
           chart_spec_json = VALUES(chart_spec_json),
           status = 'script_ready',
           error_message = NULL`,
        [
          id,
          projectId,
          segment.segmentId,
          segment.order,
          segment.title,
          segment.voiceover,
          segment.subtitle,
          segment.imagePrompt,
          segment.visualIntent,
          segment.durationSec,
          segment.chartSpec ? JSON.stringify(segment.chartSpec) : null
        ]
      );
    }
  }

  private async refreshBatchSelectedCount(batchId: string) {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM video_topic_candidates WHERE batch_id = ? AND status IN ('selected', 'project_created')",
      [batchId]
    );
    await this.pool.query("UPDATE video_topic_batches SET selected_count = ? WHERE id = ?", [
      Number(rows[0]?.count ?? 0),
      batchId
    ]);
  }
}

function mapBatch(row: BatchRow): VideoTopicBatchSummary {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    targetPlatform: row.target_platform,
    targetCount: row.target_count,
    generatedCount: row.generated_count,
    selectedCount: row.selected_count,
    summary: row.summary,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapCandidate(row: CandidateRow): VideoTopicCandidateSummary {
  return {
    id: row.id,
    batchId: row.batch_id,
    source: row.source,
    targetPlatform: row.target_platform,
    title: row.title,
    brief: row.brief,
    angle: row.angle,
    videoFormat: row.video_format,
    targetAudience: row.target_audience,
    whyThis: row.why_this,
    estimatedDurationSec: row.estimated_duration_sec,
    score: row.score,
    topicFitScore: row.topic_fit_score,
    productionScore: row.production_score,
    scoreBreakdown: safeParseJson<Record<string, number>>(row.score_breakdown_json ?? "", {}),
    riskNotes: safeParseJson<string[]>(row.risk_notes_json ?? "", []),
    sourceRefs: safeParseJson<string[]>(row.source_refs_json ?? "", []),
    status: row.status,
    latestFeedbackDecision: row.latest_feedback_decision ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapProject(row: ProjectRow): VideoProjectSummary {
  return {
    id: row.id,
    topicCandidateId: row.topic_candidate_id,
    title: row.title,
    status: row.status,
    targetPlatform: row.target_platform,
    aspectRatio: row.aspect_ratio,
    targetDurationSec: row.target_duration_sec,
    scriptConfirmedAt: row.script_confirmed_at?.toISOString() ?? null,
    visualRenderPlanConfirmedAt: row.visual_render_plan_confirmed_at?.toISOString() ?? null,
    finalVideoAssetId: row.final_video_asset_id,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapSegment(row: SegmentRow): VideoProjectSegmentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentKey: row.segment_key,
    order: row.segment_order,
    title: row.title,
    voiceover: row.voiceover,
    subtitle: row.subtitle,
    imagePrompt: row.image_prompt,
    visualBuilder: row.visual_builder,
    status: row.status,
    durationSec: row.duration_sec,
    errorMessage: row.error_message,
    updatedAt: row.updated_at.toISOString()
  };
}

function mapAsset(row: AssetRow): VideoAssetSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    segmentId: row.segment_id,
    assetType: row.asset_type,
    status: row.status,
    builder: row.builder,
    filePath: row.file_path,
    publicUrl: row.public_url,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    attemptNo: row.attempt_no,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapCaseIntent(row: CaseIntentRow): VideoCaseIntentSummary {
  const strategyParams = safeParseJson<VideoCaseStrategyConfig>(row.strategy_params_json ?? "", {
    name: "sma_crossover",
    fastWindow: 20,
    slowWindow: 60,
    side: "long_only"
  });
  const assumptions = safeParseJson<VideoCaseAssumptions>(row.assumptions_json ?? "", {
    initialCapital: 10_000,
    feeBpsEachSide: 10,
    slippageBpsEachSide: 5
  });
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    dataSource: row.data_source,
    symbol: row.symbol,
    interval: row.kline_interval,
    collectionName: row.collection_name,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    strategyName: row.strategy_name,
    strategyParams,
    assumptions,
    requestJson: safeParseJson<Record<string, unknown>>(row.request_json ?? "", {}),
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapVerifiedCasePack(row: VerifiedCasePackRow): VideoVerifiedCasePackSummary {
  const dataSource = safeParseJson<Record<string, unknown>>(row.data_source_json ?? "", {});
  const strategy = safeParseJson<Record<string, unknown>>(row.strategy_json ?? "", {});
  const metrics = safeParseJson<Record<string, unknown>>(row.metrics_json ?? "", {});
  const review = safeParseJson<VideoVerifiedCasePack["review"]>(row.review_json ?? "", {
    allowedFacts: [],
    findings: [],
    hypotheses: [],
    forbiddenClaims: [],
    contentSafety: {
      mustSay: []
    }
  });
  const chartData = safeParseJson<Record<string, unknown>>(row.chart_data_json ?? "", {});
  const pack = safeParseJson<VideoVerifiedCasePack>(row.pack_json ?? "", {
    caseId: row.case_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    dataSource,
    caseIntent: {},
    strategy,
    metrics,
    review,
    chartData
  });
  return {
    id: row.id,
    projectId: row.project_id,
    caseIntentId: row.case_intent_id,
    caseId: row.case_id,
    status: row.status,
    dataSource,
    strategy,
    metrics,
    review,
    chartData,
    pack,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapFeedbackDoc(row: FeedbackDocRow): VideoFeedbackDocumentSummary {
  return {
    id: row.id,
    scope: row.scope,
    markdown: row.markdown,
    summaryJson: row.summary_json ? safeParseJson<Record<string, unknown> | null>(row.summary_json, null) : null,
    createdAt: row.created_at.toISOString()
  };
}

function feedbackDecisionToCandidateStatus(decision: VideoTopicFeedbackDecision): VideoTopicCandidateStatus {
  if (decision === "hit") {
    return "selected";
  }
  if (decision === "not_now") {
    return "deferred";
  }
  return "rejected";
}

function isVideoVisualAssetType(assetType: VideoAssetType) {
  return assetType === "image" || assetType === "chart" || assetType === "text_card";
}
