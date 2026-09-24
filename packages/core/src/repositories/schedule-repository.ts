import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import type { JobDisplayStatus, JobStage, JobStatus, ScheduleSlot } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";

dayjs.extend(utc);
dayjs.extend(timezone);

type ScheduleRow = RowDataPacket & {
  id: number;
  account_id: number | null;
  account_name: string | null;
  scheduled_at: Date;
  status: "pending" | "in_progress" | "published" | "failed" | "manual_login_required";
  publish_job_id: number | null;
  title: string | null;
  job_status: JobStatus | null;
  current_stage: JobStage | null;
};

export class ScheduleRepository {
  constructor(private readonly pool: Pool) {}

  async backfillLegacySlots(fallbackAccountId: number) {
    await this.pool.query(
      `UPDATE daily_publish_schedule dps
       LEFT JOIN publish_jobs pj ON pj.id = dps.publish_job_id
       SET dps.account_id = COALESCE(dps.account_id, pj.account_id, ?)
       WHERE dps.account_id IS NULL`,
      [fallbackAccountId]
    );
  }

  async ensureDailySchedule(input?: { date?: string; accountIds?: number[] }) {
    const date = input?.date ?? dayjs().tz(getAppConfig().timezone).format("YYYY-MM-DD");
    const weekday = dayjs.tz(date, getAppConfig().timezone).day();
    if (weekday === 0 || weekday === 6) {
      return 0;
    }

    const accountIds = Array.from(new Set((input?.accountIds ?? []).filter((accountId) => accountId > 0)));
    if (!accountIds.length) {
      return 0;
    }

    let created = 0;
    for (const accountId of accountIds) {
      created += await this.ensureDailyScheduleForAccount(accountId, date);
    }

    return created;
  }

  async listScheduleForToday(accountId?: number): Promise<ScheduleSlot[]> {
    const today = dayjs().tz(getAppConfig().timezone).format("YYYY-MM-DD");
    return this.listScheduleForRange(today, today, accountId);
  }

  async listScheduleForWeek(accountId?: number): Promise<ScheduleSlot[]> {
    const now = dayjs().tz(getAppConfig().timezone);
    const startOfWeek = now.day() === 0 ? now.startOf("day") : now.startOf("week").add(1, "day");
    const endOfWeek = startOfWeek.add(4, "day").endOf("day");
    return this.listScheduleForRange(startOfWeek.format("YYYY-MM-DD"), endOfWeek.format("YYYY-MM-DD"), accountId);
  }

  async getNextUnassignedSlot(accountId: number) {
    const [rows] = await this.pool.query<ScheduleRow[]>(
      `SELECT s.id, s.account_id, a.name AS account_name, s.scheduled_at, s.status, s.publish_job_id, pj.title,
              pj.status AS job_status, pj.current_stage
       FROM daily_publish_schedule s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN publish_jobs pj ON pj.id = s.publish_job_id
       WHERE s.account_id = ?
         AND s.publish_job_id IS NULL
       ORDER BY s.scheduled_at ASC
       LIMIT 1`,
      [accountId]
    );

    return rows[0] ? mapScheduleRow(rows[0]) : null;
  }

  async assignJobToSlot(slotId: number, jobId: number) {
    await this.pool.query(`UPDATE daily_publish_schedule SET publish_job_id = ? WHERE id = ?`, [jobId, slotId]);
  }

  async createAdhocSlot(accountId: number, scheduledAt: Date, status: ScheduleSlot["status"] = "pending") {
    const date = dayjs(scheduledAt).tz(getAppConfig().timezone);
    const [result] = await this.pool.query<ResultSetHeader>(
      `INSERT INTO daily_publish_schedule (account_id, schedule_date, scheduled_at, status)
       VALUES (?, ?, ?, ?)`,
      [accountId, date.format("YYYY-MM-DD"), scheduledAt, status]
    );

    return result.insertId;
  }

  async getDueSlots(now = new Date()) {
    const [rows] = await this.pool.query<ScheduleRow[]>(
      `SELECT s.id, s.account_id, a.name AS account_name, s.scheduled_at, s.status, s.publish_job_id, pj.title,
              pj.status AS job_status, pj.current_stage
       FROM daily_publish_schedule s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN publish_jobs pj ON pj.id = s.publish_job_id
       WHERE s.publish_job_id IS NOT NULL
         AND s.scheduled_at <= ?
         AND s.status IN ('pending', 'manual_login_required')
       ORDER BY s.scheduled_at ASC`,
      [now]
    );

    return rows.map(mapScheduleRow);
  }

  async updateSlotStatus(slotId: number, status: ScheduleSlot["status"]) {
    await this.pool.query(`UPDATE daily_publish_schedule SET status = ? WHERE id = ?`, [status, slotId]);
  }

  async updateSlotScheduledAt(slotId: number, scheduledAt: Date) {
    const date = dayjs(scheduledAt).tz(getAppConfig().timezone);
    await this.pool.query(
      `UPDATE daily_publish_schedule
       SET schedule_date = ?,
           scheduled_at = ?
       WHERE id = ?`,
      [date.format("YYYY-MM-DD"), scheduledAt, slotId]
    );
  }

  async getSlotById(slotId: number) {
    const [rows] = await this.pool.query<ScheduleRow[]>(
      `SELECT s.id, s.account_id, a.name AS account_name, s.scheduled_at, s.status, s.publish_job_id, pj.title,
              pj.status AS job_status, pj.current_stage
       FROM daily_publish_schedule s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN publish_jobs pj ON pj.id = s.publish_job_id
       WHERE s.id = ?
       LIMIT 1`,
      [slotId]
    );

    const row = rows[0];
    return row ? mapScheduleRow(row) : null;
  }

  async getSlotByJobId(jobId: number) {
    const [rows] = await this.pool.query<ScheduleRow[]>(
      `SELECT s.id, s.account_id, a.name AS account_name, s.scheduled_at, s.status, s.publish_job_id, pj.title,
              pj.status AS job_status, pj.current_stage
       FROM daily_publish_schedule s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN publish_jobs pj ON pj.id = s.publish_job_id
       WHERE s.publish_job_id = ?
       LIMIT 1`,
      [jobId]
    );

    const row = rows[0];
    return row ? mapScheduleRow(row) : null;
  }

  private async ensureDailyScheduleForAccount(accountId: number, date: string) {
    const [existing] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count
       FROM daily_publish_schedule
       WHERE schedule_date = ?
         AND account_id = ?`,
      [date, accountId]
    );
    if (Number(existing[0]?.count ?? 0) > 0) {
      return 0;
    }

    const [accountRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT daily_publish_slots AS slots
       FROM accounts
       WHERE id = ?
       LIMIT 1`,
      [accountId]
    );
    const configuredSlots = Number(accountRows[0]?.slots ?? 0);
    const slotCount = configuredSlots > 0 ? configuredSlots : 1;
    const slots = generateSlots(date, slotCount);

    for (const slot of slots) {
      await this.pool.query(
        `INSERT INTO daily_publish_schedule (account_id, schedule_date, scheduled_at, status)
         VALUES (?, ?, ?, 'pending')`,
        [accountId, date, slot.toDate()]
      );
    }

    return slots.length;
  }

  private async listScheduleForRange(startDate: string, endDate: string, accountId?: number): Promise<ScheduleSlot[]> {
    const [rows] = await this.pool.query<ScheduleRow[]>(
      `SELECT s.id, s.account_id, a.name AS account_name, s.scheduled_at, s.status, s.publish_job_id, pj.title,
              pj.status AS job_status, pj.current_stage
       FROM daily_publish_schedule s
       LEFT JOIN accounts a ON a.id = s.account_id
       LEFT JOIN publish_jobs pj ON pj.id = s.publish_job_id
       WHERE s.schedule_date BETWEEN ? AND ?
         AND (? IS NULL OR s.account_id = ?)
       ORDER BY s.scheduled_at ASC, s.id ASC`,
      [startDate, endDate, accountId ?? null, accountId ?? null]
    );

    return rows.map(mapScheduleRow);
  }

  async reopenRetryableLockFailedSlots(now = new Date()): Promise<number> {
    const scheduleDate = dayjs(now).tz(getAppConfig().timezone).format("YYYY-MM-DD");
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<Array<RowDataPacket & { job_id: number; slot_id: number }>>(
        `SELECT pj.id AS job_id, s.id AS slot_id
         FROM publish_jobs pj
         JOIN daily_publish_schedule s ON s.publish_job_id = pj.id
         WHERE s.schedule_date = ?
           AND s.status = 'failed'
           AND pj.status = 'failed_terminal'
           AND (
             pj.failure_reason LIKE '%Deadlock%'
             OR pj.failure_reason LIKE '%try restarting transaction%'
             OR pj.failure_reason LIKE '%Lock wait timeout%'
           )
         FOR UPDATE`,
        [scheduleDate]
      );

      if (!rows.length) {
        await connection.commit();
        return 0;
      }

      const jobIds = rows.map((row) => row.job_id);
      const slotIds = rows.map((row) => row.slot_id);
      const jobPlaceholders = jobIds.map(() => "?").join(", ");
      const slotPlaceholders = slotIds.map(() => "?").join(", ");

      await connection.query(
        `UPDATE publish_jobs
         SET status = 'queued',
             current_stage = 'queued',
             failure_reason = '数据库锁冲突已自动重开，将先补题再继续准备。',
             last_error_type = NULL,
             finished_at = NULL
         WHERE id IN (${jobPlaceholders})`,
        jobIds
      );
      await connection.query(
        `UPDATE daily_publish_schedule
         SET status = 'pending'
         WHERE id IN (${slotPlaceholders})`,
        slotIds
      );
      await connection.commit();
      return rows.length;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function mapScheduleRow(row: ScheduleRow): ScheduleSlot {
  return {
    id: row.id,
    accountId: row.account_id ?? null,
    accountName: row.account_name ?? null,
    scheduledAt: row.scheduled_at.toISOString(),
    status: row.status,
    publishJobId: row.publish_job_id,
    title: row.title,
    jobStatus: row.job_status ?? null,
    jobDisplayStatus: mapJobDisplayStatus(row.job_status),
    currentStage: row.current_stage ?? null
  };
}

function mapJobDisplayStatus(status: JobStatus | null): JobDisplayStatus | null {
  if (!status) {
    return null;
  }

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

function generateSlots(date: string, slotCount: number) {
  const timezoneName = getAppConfig().timezone;
  const start = dayjs.tz(`${date} 08:00`, timezoneName);
  const end = dayjs.tz(`${date} 20:00`, timezoneName);
  const slots: dayjs.Dayjs[] = [];

  while (slots.length < slotCount) {
    const offsetMinutes = Math.floor(Math.random() * end.diff(start, "minute"));
    const candidate = start.add(offsetMinutes, "minute").second(0).millisecond(0);
    const conflict = slots.some((slot) => Math.abs(slot.diff(candidate, "minute")) < 90);

    if (!conflict) {
      slots.push(candidate);
    }
  }

  return slots.sort((left, right) => left.valueOf() - right.valueOf());
}
