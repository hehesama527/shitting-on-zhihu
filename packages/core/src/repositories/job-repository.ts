import type {
  ArtifactSummary,
  FailureType,
  JobDetail,
  JobDisplayStatus,
  JobListItem,
  JobStage,
  JobStatus,
  PublishAttemptSummary,
  SkillName,
  SkillRunSummary,
  ToolTraceStage,
  ToolTraceSummary
} from "@zhihu-mvp/shared";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { hashZhihuQuestionUrl, normalizeZhihuQuestionUrl } from "../utils/zhihu-url.js";

type JobRow = RowDataPacket & {
  id: number;
  account_id: number;
  topic_card_id: number | null;
  review_id: number | null;
  image_asset_id: string | null;
  status: JobStatus;
  title: string | null;
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  final_url: string | null;
  retry_count: number;
  failure_reason: string | null;
  prompt_version_snapshot_json: string | null;
  soul_version: number | null;
  soul_markdown_snapshot: string | null;
  current_stage: JobStage | null;
  resume_anchor_json: string | null;
  last_trace_id: string | null;
  last_error_type: FailureType | null;
  created_at: Date;
  updated_at: Date;
  schedule_slot_id?: number | null;
  schedule_status?: JobListItem["scheduleStatus"];
  latest_attempt_status?: string | null;
  latest_failure_type?: FailureType | null;
  latest_screenshot_path?: string | null;
  question_title?: string | null;
  question_url?: string | null;
  topic_summary?: string | null;
  topic_output_json?: string | null;
  draft_content?: string | null;
  humanized_content?: string | null;
  approved_content?: string | null;
  review_summary?: string | null;
  hard_gate_json?: string | null;
  editorial_review_json?: string | null;
  publish_review_json?: string | null;
  topic_duplication_json?: string | null;
  content_duplication_json?: string | null;
};

type PublishAttemptRow = RowDataPacket & {
  id: number;
  publish_job_id: number;
  attempt_no: number;
  status: string;
  current_url: string | null;
  failure_type: FailureType | null;
  failure_reason: string | null;
  attempt_json: string;
  created_at: Date;
};

type ArtifactRow = RowDataPacket & {
  id: number;
  publish_attempt_id: number | null;
  artifact_type: string;
  file_path: string;
  meta_json: string | null;
  created_at: Date;
};

type ToolTraceRow = RowDataPacket & {
  id: number;
  publish_job_id: number | null;
  publish_attempt_id: number | null;
  trace_id: string;
  stage: ToolTraceStage;
  tool_name: string;
  action: ToolTraceSummary["action"];
  input_json: string;
  result_json: string | null;
  artifact_path: string | null;
  duration_ms: number | null;
  success: number;
  error_message: string | null;
  created_at: Date;
};

type SkillRunRow = RowDataPacket & {
  id: number;
  publish_job_id: number | null;
  publish_attempt_id: number | null;
  skill_name: SkillName;
  agent_name: string;
  stage: string | null;
  trace_id: string | null;
  input_json: string;
  output_json: string | null;
  duration_ms: number | null;
  success: number;
  error_message: string | null;
  created_at: Date;
};

type StaleRunningAttemptRow = RowDataPacket & {
  attempt_id: number;
  publish_job_id: number;
  account_id: number;
  attempt_no: number;
  created_at: Date;
  current_stage: JobStage | null;
  title: string | null;
};

type JobUpdateOptions = {
  leaseOwner?: string | null;
  failureReason?: string | null;
  finalUrl?: string | null;
  currentStage?: JobStage | null;
  resumeAnchorJson?: string | null;
  promptVersionSnapshotJson?: string | null;
  soulVersion?: number | null;
  soulMarkdownSnapshot?: string | null;
  lastTraceId?: string | null;
  lastErrorType?: FailureType | null;
};

type PreparationQueryOptions = {
  now?: Date;
  withinMinutes?: number;
};

export class JobRepository {
  constructor(private readonly pool: Pool) {}

  async listJobs(accountId?: number | null): Promise<JobListItem[]> {
    const accountFilter = accountId != null ? "WHERE pj.account_id = ?" : "";
    const params = accountId != null ? [accountId] : [];
    const [rows] = await this.pool.query<JobRow[]>(
      `${buildJobListSql()}
       ${accountFilter}
       ORDER BY COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) DESC
       LIMIT 100`,
      params
    );
    return rows.map(mapJobRow);
  }

  async listPublishJobs(accountId?: number | null): Promise<JobListItem[]> {
    return this.listJobs(accountId);
  }

  async getJobById(jobId: number): Promise<JobDetail | null> {
    const [rows] = await this.pool.query<JobRow[]>(
      `${buildJobListSql()}
       WHERE pj.id = ?
       LIMIT 1`,
      [jobId]
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      ...mapJobRow(row),
      questionTitle: row.question_title ?? null,
      questionUrl: row.question_url ?? null,
      topicSummary: row.topic_summary ?? null,
      topicOutputJson: row.topic_output_json ?? null,
      draftContent: row.draft_content ?? null,
      humanizedContent: row.humanized_content ?? null,
      approvedContent: row.approved_content ?? null,
      reviewSummary: row.review_summary ?? null,
      hardGateJson: row.hard_gate_json ?? null,
      editorialReviewJson: row.editorial_review_json ?? null,
      publishReviewJson: row.publish_review_json ?? null,
      topicDuplicationJson: row.topic_duplication_json ?? null,
      contentDuplicationJson: row.content_duplication_json ?? null
    };
  }

  async createQueuedJob(input: {
    accountId: number;
    scheduledAt: string | Date | null;
    title?: string | null;
    promptVersionSnapshotJson?: string | null;
    soulVersion?: number | null;
    soulMarkdownSnapshot?: string | null;
  }) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO publish_jobs (
         account_id,
         status,
         title,
         scheduled_at,
         prompt_version_snapshot_json,
         soul_version,
         soul_markdown_snapshot,
         current_stage
       )
      VALUES (?, 'queued', ?, ?, ?, ?, ?, 'queued')`,
      [
        input.accountId,
        input.title ?? null,
        normalizeMysqlDateTime(input.scheduledAt),
        input.promptVersionSnapshotJson ?? null,
        input.soulVersion ?? null,
        input.soulMarkdownSnapshot ?? null
      ]
    );
    return result.insertId;
  }

  async deleteUnassignedQueuedJob(jobId: number) {
    await this.pool.query(
      `DELETE FROM publish_jobs
       WHERE id = ? AND status = 'queued' AND topic_card_id IS NULL AND review_id IS NULL`,
      [jobId]
    );
  }

  async replaceJobPayload(
    jobId: number,
    input: {
      topicCardId: number;
      reviewId: number;
      title: string;
      promptVersionSnapshotJson: string | null;
      leaseOwner?: string | null;
    }
  ) {
    await this.pool.query(
      `UPDATE publish_jobs
       SET topic_card_id = ?,
           review_id = ?,
           title = ?,
           status = 'review_passed',
           failure_reason = NULL,
           retry_count = 0,
           prompt_version_snapshot_json = ?,
           current_stage = 'review_passed',
           resume_anchor_json = NULL,
           last_error_type = NULL
       WHERE id = ?
         AND (
           (? IS NOT NULL AND lease_owner = ? AND lease_until >= NOW())
           OR (? IS NULL AND (lease_owner IS NULL OR lease_until < NOW()))
         )`,
      [
        input.topicCardId,
        input.reviewId,
        input.title,
        input.promptVersionSnapshotJson,
        jobId,
        input.leaseOwner ?? null,
        input.leaseOwner ?? null,
        input.leaseOwner ?? null
      ]
    );
  }

  async updateScheduledAt(jobId: number, scheduledAt: string | Date | null) {
    await this.pool.query(
      `UPDATE publish_jobs SET scheduled_at = ? WHERE id = ?`,
      [normalizeMysqlDateTime(scheduledAt), jobId]
    );
  }

  async updateJobStatus(jobId: number, status: JobStatus, options?: JobUpdateOptions) {
    const leaseOwner = options?.leaseOwner ?? null;
    const hasFailureReason = options ? Object.prototype.hasOwnProperty.call(options, "failureReason") : false;
    const hasFinalUrl = options ? Object.prototype.hasOwnProperty.call(options, "finalUrl") : false;
    const hasCurrentStage = options ? Object.prototype.hasOwnProperty.call(options, "currentStage") : false;
    const hasResumeAnchor = options ? Object.prototype.hasOwnProperty.call(options, "resumeAnchorJson") : false;
    const hasPromptSnapshot = options ? Object.prototype.hasOwnProperty.call(options, "promptVersionSnapshotJson") : false;
    const hasSoulVersion = options ? Object.prototype.hasOwnProperty.call(options, "soulVersion") : false;
    const hasSoulMarkdownSnapshot = options ? Object.prototype.hasOwnProperty.call(options, "soulMarkdownSnapshot") : false;
    const hasLastTraceId = options ? Object.prototype.hasOwnProperty.call(options, "lastTraceId") : false;
    const hasLastErrorType = options ? Object.prototype.hasOwnProperty.call(options, "lastErrorType") : false;

    await this.pool.query(
      `UPDATE publish_jobs
       SET status = ?,
           failure_reason = CASE WHEN ? THEN ? ELSE failure_reason END,
           final_url = CASE WHEN ? THEN ? ELSE final_url END,
           current_stage = CASE WHEN ? THEN ? ELSE current_stage END,
           resume_anchor_json = CASE WHEN ? THEN ? ELSE resume_anchor_json END,
           prompt_version_snapshot_json = CASE WHEN ? THEN ? ELSE prompt_version_snapshot_json END,
           soul_version = CASE WHEN ? THEN ? ELSE soul_version END,
           soul_markdown_snapshot = CASE WHEN ? THEN ? ELSE soul_markdown_snapshot END,
           last_trace_id = CASE WHEN ? THEN ? ELSE last_trace_id END,
           last_error_type = CASE WHEN ? THEN ? ELSE last_error_type END,
           started_at = CASE WHEN ? = 'publishing' AND started_at IS NULL THEN CURRENT_TIMESTAMP ELSE started_at END,
           finished_at = CASE WHEN ? IN ('published', 'failed_terminal') THEN CURRENT_TIMESTAMP ELSE finished_at END
        WHERE id = ?
          AND status NOT IN ('published', 'failed_terminal')
          AND (
            (? IS NOT NULL AND lease_owner = ? AND lease_until >= NOW())
            OR (? IS NULL AND (lease_owner IS NULL OR lease_until < NOW()))
          )`,
      [
        status,
        hasFailureReason ? 1 : 0,
        options?.failureReason ?? null,
        hasFinalUrl ? 1 : 0,
        options?.finalUrl ?? null,
        hasCurrentStage ? 1 : 0,
        options?.currentStage ?? null,
        hasResumeAnchor ? 1 : 0,
        options?.resumeAnchorJson ?? null,
        hasPromptSnapshot ? 1 : 0,
        options?.promptVersionSnapshotJson ?? null,
        hasSoulVersion ? 1 : 0,
        options?.soulVersion ?? null,
        hasSoulMarkdownSnapshot ? 1 : 0,
        options?.soulMarkdownSnapshot ?? null,
        hasLastTraceId ? 1 : 0,
        options?.lastTraceId ?? null,
        hasLastErrorType ? 1 : 0,
        options?.lastErrorType ?? null,
         status,
         status,
         jobId,
         leaseOwner,
         leaseOwner,
         leaseOwner
      ]
    );
  }

  async claimJob(jobId: number, owner: string, phase: "prepare" | "publish", leaseMinutes = 15) {
    const leaseUntil = new Date(Date.now() + leaseMinutes * 60_000);
    const statuses = phase === "prepare"
      ? ["queued", "topic_discovery", "topic_agent", "topic_review", "writer", "humanizing", "review_hard_gate", "review_editorial", "review_publish"]
      : ["review_passed", "login_checking", "publishing", "publish_verify", "retry_waiting"];
    const placeholders = statuses.map(() => "?").join(", ");
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE publish_jobs
       SET lease_owner = ?,
           lease_until = ?,
           status = CASE WHEN ? = 'publish' THEN 'publishing' ELSE status END,
           current_stage = CASE WHEN ? = 'publish' THEN 'login_checking' ELSE current_stage END
       WHERE id = ?
         AND status IN (${placeholders})
         AND (lease_until IS NULL OR lease_until < NOW())`,
      [owner, leaseUntil, phase, phase, jobId, ...statuses]
    );
    return result.affectedRows === 1;
  }

  async renewJobLease(jobId: number, owner: string, leaseMinutes = 15) {
    const leaseUntil = new Date(Date.now() + leaseMinutes * 60_000);
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE publish_jobs
       SET lease_until = ?
       WHERE id = ? AND lease_owner = ? AND lease_until >= NOW()`,
      [leaseUntil, jobId, owner]
    );
    return result.affectedRows === 1;
  }

  async releaseJobLease(jobId: number, owner: string) {
    await this.pool.query(
      `UPDATE publish_jobs SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`,
      [jobId, owner]
    );
  }

  async finalizePublishedAtomically(input: {
    jobId: number;
    attemptId: number;
    leaseOwner: string;
    accountId: number;
    slotId: number | null;
    topicCardId: number | null;
    reviewId: number | null;
    questionUrl: string;
    questionTitle: string;
    finalUrl: string;
    attemptPayload: unknown;
    screenshotPath?: string | null;
    artifactPhase?: string;
  }) {
    const questionUrl = normalizeZhihuQuestionUrl(input.questionUrl);
    const questionUrlHash = hashZhihuQuestionUrl(questionUrl);
    if (!questionUrl || !questionUrlHash) {
      throw new Error(`Cannot finalize job #${input.jobId}: invalid question URL.`);
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [jobResult] = await connection.query<ResultSetHeader>(
        `UPDATE publish_jobs
         SET status = 'published', final_url = ?, failure_reason = NULL,
             current_stage = 'published', resume_anchor_json = NULL,
             last_error_type = NULL, finished_at = CURRENT_TIMESTAMP,
             lease_owner = NULL, lease_until = NULL
         WHERE id = ? AND account_id = ? AND lease_owner = ? AND lease_until >= NOW()
           AND status NOT IN ('published', 'failed_terminal')`,
        [input.finalUrl, input.jobId, input.accountId, input.leaseOwner]
      );
      if (jobResult.affectedRows !== 1) {
        await connection.rollback();
        return false;
      }
      await connection.query(
        `UPDATE publish_attempts SET status = 'published', current_url = ?, attempt_json = ?, failure_type = NULL, failure_reason = NULL WHERE id = ?`,
        [input.finalUrl, JSON.stringify(input.attemptPayload), input.attemptId]
      );
      await connection.query(
        `UPDATE publish_attempts SET status = 'failed', failure_reason = COALESCE(failure_reason, 'Superseded by a successful publish attempt.') WHERE publish_job_id = ? AND id <> ? AND status = 'running'`,
        [input.jobId, input.attemptId]
      );
      if (input.screenshotPath) {
        await connection.query(
          `INSERT INTO artifacts (publish_attempt_id, artifact_type, file_path, meta_json) VALUES (?, 'screenshot', ?, ?)`,
          [input.attemptId, input.screenshotPath, JSON.stringify({ phase: input.artifactPhase ?? "publish-verify" })]
        );
      }
      if (input.slotId != null) {
        await connection.query(
          `UPDATE daily_publish_schedule SET status = 'published' WHERE id = ? AND publish_job_id = ?`,
          [input.slotId, input.jobId]
        );
      }
      if (input.topicCardId != null) {
        await connection.query(
          `UPDATE topic_candidates tc JOIN topic_cards card ON card.topic_candidate_id = tc.id SET tc.status = 'published' WHERE card.id = ?`,
          [input.topicCardId]
        );
      }
      await connection.query(
        `INSERT INTO answered_topics
         (account_id, question_url_hash, question_url, question_title, topic_card_id, review_id, publish_job_id, answer_url, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE question_url = VALUES(question_url), question_title = VALUES(question_title),
           topic_card_id = VALUES(topic_card_id), review_id = VALUES(review_id),
           publish_job_id = VALUES(publish_job_id), answer_url = VALUES(answer_url),
           answered_at = GREATEST(answered_at, VALUES(answered_at))`,
        [input.accountId, questionUrlHash, questionUrl, input.questionTitle, input.topicCardId, input.reviewId, input.jobId, input.finalUrl]
      );
      await connection.query(
        `UPDATE accounts SET status = 'active', status_reason = NULL, cooldown_until = NULL,
         last_publish_at = CURRENT_TIMESTAMP, last_login_check_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [input.accountId]
      );
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateJobRuntimeContext(
    jobId: number,
    input: {
      currentStage?: JobStage | null;
      lastTraceId?: string | null;
      lastErrorType?: FailureType | null;
    }
  ) {
    const hasCurrentStage = Object.prototype.hasOwnProperty.call(input, "currentStage");
    const hasLastTraceId = Object.prototype.hasOwnProperty.call(input, "lastTraceId");
    const hasLastErrorType = Object.prototype.hasOwnProperty.call(input, "lastErrorType");

    await this.pool.query(
      `UPDATE publish_jobs
       SET current_stage = CASE WHEN ? THEN ? ELSE current_stage END,
           last_trace_id = CASE WHEN ? THEN ? ELSE last_trace_id END,
           last_error_type = CASE WHEN ? THEN ? ELSE last_error_type END
       WHERE id = ?`,
      [
        hasCurrentStage ? 1 : 0,
        input.currentStage ?? null,
        hasLastTraceId ? 1 : 0,
        input.lastTraceId ?? null,
        hasLastErrorType ? 1 : 0,
        input.lastErrorType ?? null,
        jobId
      ]
    );
  }

  async incrementRetry(jobId: number, leaseOwner?: string | null) {
    await this.pool.query(
      `UPDATE publish_jobs
       SET retry_count = retry_count + 1
       WHERE id = ?
         AND (
           (? IS NOT NULL AND lease_owner = ? AND lease_until >= NOW())
           OR (? IS NULL AND (lease_owner IS NULL OR lease_until < NOW()))
         )`,
      [jobId, leaseOwner ?? null, leaseOwner ?? null, leaseOwner ?? null]
    );
  }

  async listBlockedJobs(accountId: number): Promise<JobListItem[]> {
    const [rows] = await this.pool.query<JobRow[]>(
      `${buildJobListSql()}
       WHERE pj.account_id = ? AND pj.status = 'manual_login_required'
       ORDER BY COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) ASC`,
      [accountId]
    );
    return rows.map(mapJobRow);
  }

  async getJobsNeedingPreparation(limit = 10, options?: PreparationQueryOptions): Promise<JobListItem[]> {
    const params: Array<number | Date> = [];
    let scheduleWindowClause = "";

    if (typeof options?.withinMinutes === "number") {
      const now = options.now ?? new Date();
      scheduleWindowClause = `
         AND COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) <= ?`;
      params.push(addMinutes(now, options.withinMinutes));
    }

    params.push(limit);

    const [rows] = await this.pool.query<JobRow[]>(
      `${buildJobListSql()}
       WHERE pj.status IN (
         'queued',
         'topic_discovery',
         'topic_agent',
         'topic_review',
         'writer',
         'humanizing',
         'review_hard_gate',
         'review_editorial',
         'review_publish'
       )
       ${scheduleWindowClause}
       ORDER BY COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) ASC
       LIMIT ?`,
      params
    );

    return rows.map(mapJobRow);
  }

  async hasScheduledJobsInWindow(input: { start: Date; end: Date; accountId?: number | null }): Promise<boolean> {
    const params: Array<number | Date> = [input.start, input.end];
    let accountClause = "";
    if (input.accountId != null) {
      accountClause = "AND pj.account_id = ?";
      params.push(input.accountId);
    }

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT pj.id
       FROM publish_jobs pj
       LEFT JOIN daily_publish_schedule dps ON dps.publish_job_id = pj.id
       WHERE pj.status NOT IN ('published', 'failed_terminal')
         AND COALESCE(dps.scheduled_at, pj.scheduled_at) IS NOT NULL
         AND COALESCE(dps.scheduled_at, pj.scheduled_at) > ?
         AND COALESCE(dps.scheduled_at, pj.scheduled_at) <= ?
         ${accountClause}
       ORDER BY COALESCE(dps.scheduled_at, pj.scheduled_at) ASC
       LIMIT 1`,
      params
    );

    return rows.length > 0;
  }

  async getDueJobs(now = new Date()): Promise<JobListItem[]> {
    const [rows] = await this.pool.query<JobRow[]>(
      `${buildJobListSql()}
       WHERE COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) <= ?
         AND pj.status IN (
           'review_passed',
           'login_checking',
           'publishing',
           'publish_verify',
           'retry_waiting',
           'manual_login_required'
         )
       ORDER BY COALESCE(dps.scheduled_at, pj.scheduled_at, pj.created_at) ASC`,
      [now]
    );
    return rows.map(mapJobRow);
  }

  async listStaleRunningAttempts(olderThanMinutes = 30) {
    const cutoff = addMinutes(new Date(), -olderThanMinutes);
    const [rows] = await this.pool.query<StaleRunningAttemptRow[]>(
      `SELECT
         pa.id AS attempt_id,
         pa.publish_job_id,
         pj.account_id,
         pa.attempt_no,
         pa.created_at,
         pj.current_stage,
         pj.title
       FROM publish_attempts pa
       JOIN publish_jobs pj ON pj.id = pa.publish_job_id
       WHERE pa.status = 'running'
         AND pj.status NOT IN ('published', 'failed_terminal')
         AND pa.created_at <= ?
       ORDER BY pa.created_at ASC`,
      [cutoff]
    );

    return rows.map((row) => ({
      attemptId: row.attempt_id,
      publishJobId: row.publish_job_id,
      accountId: row.account_id,
      attemptNo: row.attempt_no,
      createdAt: row.created_at.toISOString(),
      currentStage: row.current_stage ?? null,
      title: row.title ?? null
    }));
  }

  async cleanupRunningAttemptsForJob(
    jobId: number,
    input: {
      exceptAttemptId?: number | null;
      reason: string;
    }
  ) {
    const hasExceptAttemptId = typeof input.exceptAttemptId === "number";
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE publish_attempts
       SET status = 'failed',
           failure_reason = CASE
             WHEN failure_reason IS NULL OR failure_reason = '' THEN ?
             ELSE failure_reason
           END
       WHERE publish_job_id = ?
         AND status = 'running'
         AND (? = 0 OR id <> ?)`,
      [input.reason, jobId, hasExceptAttemptId ? 1 : 0, input.exceptAttemptId ?? 0]
    );

    return result.affectedRows;
  }

  async retryJob(jobId: number, leaseOwner?: string | null) {
    await this.pool.query(
      `UPDATE publish_jobs
       SET status = 'retry_waiting',
           current_stage = 'retry_waiting',
           final_url = NULL,
           failure_reason = NULL,
           last_error_type = NULL,
           retry_count = 0,
           resume_anchor_json = NULL,
           last_trace_id = NULL,
           started_at = NULL,
           finished_at = NULL
       WHERE id = ?
         AND (
           (? IS NOT NULL AND lease_owner = ? AND lease_until >= NOW())
           OR (? IS NULL AND (lease_owner IS NULL OR lease_until < NOW()))
         )`,
      [jobId, leaseOwner ?? null, leaseOwner ?? null, leaseOwner ?? null]
    );
  }

  async bindImageAsset(jobId: number, imageAssetId: string | null) {
    await this.pool.query(
      `UPDATE publish_jobs
       SET image_asset_id = ?
       WHERE id = ?`,
      [imageAssetId, jobId]
    );
  }

  async createPublishAttempt(
    jobId: number,
    attemptNo: number,
    status: string,
    currentUrl: string | null,
    payload: unknown,
    failureType?: FailureType | null,
    failureReason?: string | null
  ) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO publish_attempts (publish_job_id, attempt_no, status, current_url, failure_type, failure_reason, attempt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, attemptNo, status, currentUrl, failureType ?? null, failureReason ?? null, JSON.stringify(payload)]
    );
    return result.insertId;
  }

  async updatePublishAttempt(
    attemptId: number,
    input: {
      status: string;
      currentUrl?: string | null;
      payload?: unknown;
      failureType?: FailureType | null;
      failureReason?: string | null;
    }
  ) {
    const hasCurrentUrl = Object.prototype.hasOwnProperty.call(input, "currentUrl");
    const hasPayload = Object.prototype.hasOwnProperty.call(input, "payload");
    const hasFailureType = Object.prototype.hasOwnProperty.call(input, "failureType");
    const hasFailureReason = Object.prototype.hasOwnProperty.call(input, "failureReason");

    await this.pool.query(
      `UPDATE publish_attempts
       SET status = ?,
           current_url = CASE WHEN ? THEN ? ELSE current_url END,
           attempt_json = CASE WHEN ? THEN ? ELSE attempt_json END,
           failure_type = CASE WHEN ? THEN ? ELSE failure_type END,
           failure_reason = CASE WHEN ? THEN ? ELSE failure_reason END
       WHERE id = ?`,
      [
        input.status,
        hasCurrentUrl ? 1 : 0,
        input.currentUrl ?? null,
        hasPayload ? 1 : 0,
        hasPayload ? JSON.stringify(input.payload) : null,
        hasFailureType ? 1 : 0,
        input.failureType ?? null,
        hasFailureReason ? 1 : 0,
        input.failureReason ?? null,
        attemptId
      ]
    );
  }

  async listPublishAttempts(jobId: number): Promise<PublishAttemptSummary[]> {
    const [rows] = await this.pool.query<PublishAttemptRow[]>(
      `SELECT * FROM publish_attempts WHERE publish_job_id = ? ORDER BY attempt_no DESC, id DESC`,
      [jobId]
    );
    return rows.map((row) => ({
      id: row.id,
      publishJobId: row.publish_job_id,
      attemptNo: row.attempt_no,
      status: row.status,
      currentUrl: row.current_url,
      failureType: row.failure_type,
      failureReason: row.failure_reason,
      attemptJson: row.attempt_json,
      createdAt: row.created_at.toISOString()
    }));
  }

  async listArtifacts(jobId: number): Promise<ArtifactSummary[]> {
    const [rows] = await this.pool.query<ArtifactRow[]>(
      `SELECT a.*
       FROM artifacts a
       JOIN publish_attempts p ON p.id = a.publish_attempt_id
       WHERE p.publish_job_id = ?
       ORDER BY a.created_at DESC, a.id DESC`,
      [jobId]
    );

    return rows.map((row) => ({
      id: row.id,
      publishAttemptId: row.publish_attempt_id,
      artifactType: row.artifact_type,
      filePath: row.file_path,
      metaJson: row.meta_json,
      createdAt: row.created_at.toISOString()
    }));
  }

  async createArtifact(publishAttemptId: number | null, artifactType: string, filePath: string, metaJson?: unknown) {
    await this.pool.query(
      `INSERT INTO artifacts (publish_attempt_id, artifact_type, file_path, meta_json)
       VALUES (?, ?, ?, ?)`,
      [publishAttemptId, artifactType, filePath, metaJson ? JSON.stringify(metaJson) : null]
    );
  }

  async createToolTrace(input: {
    publishJobId: number | null;
    publishAttemptId: number | null;
    traceId: string;
    stage: ToolTraceStage;
    toolName: string;
    action: ToolTraceSummary["action"];
    inputJson: string;
    resultJson?: string | null;
    artifactPath?: string | null;
    durationMs?: number | null;
    success: boolean;
    errorMessage?: string | null;
  }) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO tool_traces (
         publish_job_id,
         publish_attempt_id,
         trace_id,
         stage,
         tool_name,
         action,
         input_json,
         result_json,
         artifact_path,
         duration_ms,
         success,
         error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.publishJobId,
        input.publishAttemptId,
        input.traceId,
        input.stage,
        input.toolName,
        input.action,
        input.inputJson,
        input.resultJson ?? null,
        input.artifactPath ?? null,
        input.durationMs ?? null,
        input.success ? 1 : 0,
        input.errorMessage ?? null
      ]
    );
    return result.insertId;
  }

  async listToolTraces(jobId: number): Promise<ToolTraceSummary[]> {
    const [rows] = await this.pool.query<ToolTraceRow[]>(
      `SELECT *
       FROM tool_traces
       WHERE publish_job_id = ?
       ORDER BY created_at DESC, id DESC`,
      [jobId]
    );

    return rows.map((row) => ({
      id: row.id,
      publishJobId: row.publish_job_id,
      publishAttemptId: row.publish_attempt_id,
      traceId: row.trace_id,
      stage: row.stage,
      toolName: row.tool_name,
      action: row.action,
      inputJson: row.input_json,
      resultJson: row.result_json,
      artifactPath: row.artifact_path,
      durationMs: row.duration_ms,
      success: Boolean(row.success),
      errorMessage: row.error_message,
      createdAt: row.created_at.toISOString()
    }));
  }

  async createSkillRun(input: {
    publishJobId: number | null;
    publishAttemptId: number | null;
    skillName: SkillName;
    agentName: string;
    stage?: string | null;
    traceId?: string | null;
    inputJson: string;
    outputJson?: string | null;
    durationMs?: number | null;
    success: boolean;
    errorMessage?: string | null;
  }) {
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO skill_runs (
         publish_job_id,
         publish_attempt_id,
         skill_name,
         agent_name,
         stage,
         trace_id,
         input_json,
         output_json,
         duration_ms,
         success,
         error_message
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.publishJobId,
        input.publishAttemptId,
        input.skillName,
        input.agentName,
        input.stage ?? null,
        input.traceId ?? null,
        input.inputJson,
        input.outputJson ?? null,
        input.durationMs ?? null,
        input.success ? 1 : 0,
        input.errorMessage ?? null
      ]
    );
    return result.insertId;
  }

  async listSkillRuns(jobId: number): Promise<SkillRunSummary[]> {
    const [rows] = await this.pool.query<SkillRunRow[]>(
      `SELECT *
       FROM skill_runs
       WHERE publish_job_id = ?
       ORDER BY created_at DESC, id DESC`,
      [jobId]
    );

    return rows.map((row) => ({
      id: row.id,
      publishJobId: row.publish_job_id,
      publishAttemptId: row.publish_attempt_id,
      skillName: row.skill_name,
      agentName: row.agent_name,
      stage: row.stage,
      traceId: row.trace_id,
      inputJson: row.input_json,
      outputJson: row.output_json,
      durationMs: row.duration_ms,
      success: Boolean(row.success),
      errorMessage: row.error_message,
      createdAt: row.created_at.toISOString()
    }));
  }
}

function buildJobListSql() {
  return `SELECT
            pj.*,
            dps.id AS schedule_slot_id,
            dps.status AS schedule_status,
            pa.status AS latest_attempt_status,
            pa.failure_type AS latest_failure_type,
            artifact_latest.file_path AS latest_screenshot_path,
            tc.question_title,
            tc.question_url,
            tcard.summary_text AS topic_summary,
            tcard.output_json AS topic_output_json,
            draft_raw.content AS draft_content,
            draft_humanized.content AS humanized_content,
            rv.approved_content,
            rv.review_summary,
            rv.hard_gate_json,
            rv.editorial_review_json,
            rv.publish_review_json,
            rv.topic_duplication_json,
            rv.content_duplication_json
          FROM publish_jobs pj
          LEFT JOIN daily_publish_schedule dps ON dps.publish_job_id = pj.id
          LEFT JOIN topic_cards tcard ON tcard.id = pj.topic_card_id
          LEFT JOIN topic_candidates tc ON tc.id = tcard.topic_candidate_id
          LEFT JOIN drafts draft_raw ON draft_raw.id = (
            SELECT dr.id
            FROM drafts dr
            WHERE dr.topic_card_id = tcard.id AND dr.draft_type = 'raw'
            ORDER BY dr.id DESC
            LIMIT 1
          )
          LEFT JOIN drafts draft_humanized ON draft_humanized.id = (
            SELECT dh.id
            FROM drafts dh
            WHERE dh.topic_card_id = tcard.id AND dh.draft_type = 'humanized'
            ORDER BY dh.id DESC
            LIMIT 1
          )
          LEFT JOIN reviews rv ON rv.id = pj.review_id
          LEFT JOIN publish_attempts pa ON pa.id = (
            SELECT p2.id
            FROM publish_attempts p2
            WHERE p2.publish_job_id = pj.id
            ORDER BY p2.attempt_no DESC, p2.id DESC
            LIMIT 1
          )
          LEFT JOIN artifacts artifact_latest ON artifact_latest.id = (
            SELECT a2.id
            FROM artifacts a2
            JOIN publish_attempts p3 ON p3.id = a2.publish_attempt_id
            WHERE p3.publish_job_id = pj.id AND a2.artifact_type = 'screenshot'
            ORDER BY a2.created_at DESC, a2.id DESC
            LIMIT 1
          )`;
}

function mapJobRow(row: JobRow): JobListItem {
  return {
    id: row.id,
    accountId: row.account_id,
    topicCardId: row.topic_card_id,
    reviewId: row.review_id,
    imageAssetId: row.image_asset_id ?? null,
    status: row.status,
    displayStatus: mapDisplayStatus(row.status),
    title: row.title,
    scheduledAt: row.scheduled_at?.toISOString() ?? null,
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    finalUrl: row.final_url,
    retryCount: row.retry_count,
    failureReason: row.failure_reason,
    lastErrorType: row.last_error_type ?? row.latest_failure_type ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    scheduleSlotId: row.schedule_slot_id ?? null,
    scheduleStatus: row.schedule_status ?? null,
    currentStage: row.current_stage ?? null,
    resumeAnchorJson: row.resume_anchor_json ?? null,
    promptVersionSnapshotJson: row.prompt_version_snapshot_json ?? null,
    soulVersion: row.soul_version ?? null,
    soulMarkdownSnapshot: row.soul_markdown_snapshot ?? null,
    latestAttemptStatus: row.latest_attempt_status ?? null,
    latestFailureType: row.latest_failure_type ?? null,
    latestScreenshotPath: row.latest_screenshot_path ?? null,
    questionTitle: row.question_title ?? null,
    questionUrl: row.question_url ?? null
  };
}

function mapDisplayStatus(status: JobStatus): JobDisplayStatus {
  if (status === "queued") {
    return "queued";
  }

  if (
    status === "topic_discovery" ||
    status === "topic_agent" ||
    status === "topic_review" ||
    status === "writer" ||
    status === "humanizing" ||
    status === "review_hard_gate" ||
    status === "review_editorial" ||
    status === "review_publish"
  ) {
    return "reviewing";
  }

  if (status === "needs_manual_review") {
    return "needs_manual_review";
  }

  if (status === "review_passed") {
    return "ready_to_publish";
  }

  if (status === "login_checking" || status === "publishing" || status === "publish_verify" || status === "retry_waiting") {
    return "publishing";
  }

  if (status === "manual_login_required") {
    return "manual_login_required";
  }

  if (status === "published") {
    return "published";
  }

  return "publish_failed";
}

function normalizeMysqlDateTime(value: string | Date | null) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}
