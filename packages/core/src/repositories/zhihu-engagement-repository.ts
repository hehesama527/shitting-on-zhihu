import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ZhihuEngagementSnapshot } from "@zhihu-mvp/shared";

type SnapshotRow = RowDataPacket & {
  id: number;
  publish_job_id: number;
  account_id: number;
  title: string | null;
  post_url: string;
  vote_count: number;
  comment_count: number;
  comments_json: string | null;
  status: "succeeded" | "failed";
  error_message: string | null;
  collected_at: Date;
};

export class ZhihuEngagementRepository {
  constructor(private readonly pool: Pool) {}

  async createSnapshot(input: {
    jobId: number;
    accountId: number;
    postUrl: string;
    voteCount: number;
    commentCount: number;
    comments: ZhihuEngagementSnapshot["comments"];
    status?: "succeeded" | "failed";
    errorMessage?: string | null;
  }) {
    const [result] = await this.pool.execute(
      `INSERT INTO zhihu_engagement_snapshots
       (publish_job_id, account_id, post_url, vote_count, comment_count, comments_json, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.jobId, input.accountId, input.postUrl, input.voteCount, input.commentCount, JSON.stringify(input.comments), input.status ?? "succeeded", input.errorMessage ?? null]
    );
    return Number((result as { insertId: number }).insertId);
  }

  async listSnapshots(accountId?: number | null): Promise<ZhihuEngagementSnapshot[]> {
    const [rows] = await this.pool.query<SnapshotRow[]>(
      `SELECT s.*, pj.title
       FROM zhihu_engagement_snapshots s
       JOIN publish_jobs pj ON pj.id = s.publish_job_id
       ${accountId == null ? "" : "WHERE s.account_id = ?"}
       ORDER BY s.collected_at DESC LIMIT 200`,
      accountId == null ? [] : [accountId]
    );
    return rows.map((row) => ({
      id: row.id,
      jobId: row.publish_job_id,
      accountId: row.account_id,
      title: row.title,
      postUrl: row.post_url,
      voteCount: row.vote_count,
      commentCount: row.comment_count,
      comments: parseComments(row.comments_json),
      collectedAt: new Date(row.collected_at).toISOString(),
      status: row.status,
      errorMessage: row.error_message
    }));
  }
}

function parseComments(value: string | null): ZhihuEngagementSnapshot["comments"] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
