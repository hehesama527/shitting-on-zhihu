import crypto from "node:crypto";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { FailureType, JobStage, OpsIncidentSeverity, OpsIncidentSource } from "@zhihu-mvp/shared";
import { getAppConfig } from "../config/env.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type FeishuNotificationDelivery = "sent" | "disabled" | "failed";

export type FeishuNotificationResult = {
  ok: boolean;
  enabled: boolean;
  delivery: FeishuNotificationDelivery;
  message: string;
};

export type FeishuProblemNotificationInput = {
  accountName: string;
  zhihuUserName: string | null;
  jobId: number | null;
  currentStage: JobStage | string;
  triggerStage: string;
  failureType: FailureType | string;
  failureReason: string;
  questionTitle: string | null;
  entryUrl: string | null;
  note?: string | null;
};

export type FeishuPublishSuccessNotificationInput = {
  accountName: string;
  zhihuUserName: string | null;
  jobId: number;
  publishStage: string;
  questionTitle: string | null;
  publishedAt?: string | Date | null;
  scheduledAt?: string | Date | null;
  finalUrl: string | null;
};

export type FeishuOpsIncidentNotificationInput = {
  serviceName: string;
  severity: OpsIncidentSeverity;
  source: OpsIncidentSource;
  failureType: string | null;
  accountId: number | null;
  jobId: number | null;
  title: string;
  diagnosisSummary: string | null;
  rootCause: string | null;
  suggestedAction: string | null;
  rawErrorExcerpt: string | null;
  entryUrl: string | null;
  currentStage: string | null;
  triggerStage: string | null;
  questionTitle: string | null;
};

export type FeishuVideoTopicNotificationInput = {
  batchId: string;
  source: string;
  count: number;
  entryUrl: string | null;
};

export class FeishuNotificationService {
  async sendProblemNotification(input: FeishuProblemNotificationInput): Promise<FeishuNotificationResult> {
    const lines = [
      "【知乎矩阵任务异常】",
      `矩阵账号：${input.accountName}`,
      `知乎账号：${formatValue(input.zhihuUserName)}`,
      `任务：${input.jobId != null ? `#${input.jobId}` : "无"}`,
      `当前阶段：${input.currentStage}`,
      `触发步骤：${formatValue(input.triggerStage)}`,
      `类型：${formatValue(input.failureType)}`,
      `标题：${formatValue(input.questionTitle)}`,
      `原因：${formatValue(input.failureReason)}`,
      `入口：${formatValue(input.entryUrl)}`
    ];

    if (input.note) {
      lines.push(`说明：${input.note}`);
    }

    return this.sendTextMessage(lines.join("\n"));
  }

  async sendPublishSuccessNotification(
    input: FeishuPublishSuccessNotificationInput
  ): Promise<FeishuNotificationResult> {
    const lines = [
      "【知乎发布成功】",
      `矩阵账号：${input.accountName}`,
      `知乎账号：${formatValue(input.zhihuUserName)}`,
      `任务：#${input.jobId}`,
      "当前阶段：published",
      `发布步骤：${formatValue(input.publishStage)}`,
      `标题：${formatValue(input.questionTitle)}`,
      `时间：${this.formatTime(input.publishedAt ?? new Date())}`,
      `链接：${formatValue(input.finalUrl)}`
    ];

    if (input.scheduledAt) {
      lines.push(`计划时间：${this.formatTime(input.scheduledAt)}`);
    }

    return this.sendTextMessage(lines.join("\n"));
  }

  async sendOpsIncidentNotification(input: FeishuOpsIncidentNotificationInput): Promise<FeishuNotificationResult> {
    const lines = [
      "[Ops Incident]",
      `Service: ${input.serviceName}`,
      `Severity: ${input.severity}`,
      `Source: ${input.source}`,
      `Failure Type: ${formatValue(input.failureType)}`,
      `Job: ${input.jobId != null ? `#${input.jobId}` : "N/A"}`,
      `Account: ${input.accountId != null ? `#${input.accountId}` : "N/A"}`,
      `Current Stage: ${formatValue(input.currentStage)}`,
      `Trigger Stage: ${formatValue(input.triggerStage)}`,
      `Question: ${formatValue(input.questionTitle)}`,
      `Title: ${input.title}`,
      `Summary: ${formatValue(input.diagnosisSummary)}`,
      `Root Cause: ${formatValue(input.rootCause)}`,
      `Key Error: ${formatValue(input.rawErrorExcerpt)}`,
      `Suggested Action: ${formatValue(input.suggestedAction)}`,
      `Entry: ${formatValue(input.entryUrl)}`,
      `Detected At: ${this.formatTime(new Date())}`
    ];

    return this.sendTextMessage(lines.join("\n"));
  }

  async sendVideoTopicNotification(input: FeishuVideoTopicNotificationInput): Promise<FeishuNotificationResult> {
    const lines = [
      "[Video Hub] 选题已生成",
      `Batch: ${input.batchId}`,
      `Source: ${input.source}`,
      `Count: ${input.count}`,
      `Entry: ${formatValue(input.entryUrl)}`,
      `Time: ${this.formatTime(new Date())}`
    ];

    return this.sendTextMessage(lines.join("\n"));
  }

  async sendTestNotification(): Promise<FeishuNotificationResult> {
    const lines = [
      "【飞书通知测试】",
      "状态：飞书机器人通知链路可用。",
      `时间：${this.formatTime(new Date())}`
    ];

    return this.sendTextMessage(lines.join("\n"));
  }

  private async sendTextMessage(text: string): Promise<FeishuNotificationResult> {
    const { feishuBotWebhookUrl, feishuBotSecret } = getAppConfig();
    if (!feishuBotWebhookUrl) {
      return {
        ok: true,
        enabled: false,
        delivery: "disabled",
        message: "未配置 FEISHU_BOT_WEBHOOK_URL，已跳过飞书通知。"
      };
    }

    const requestBody: Record<string, unknown> = {
      msg_type: "text",
      content: {
        text
      }
    };

    if (feishuBotSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      requestBody.timestamp = timestamp;
      requestBody.sign = createFeishuSignature(timestamp, feishuBotSecret);
    }

    try {
      const response = await fetch(feishuBotWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
      const rawResponse = await response.text();
      const parsedResponse = parseJsonSafely(rawResponse);

      if (!response.ok || !isFeishuSuccess(parsedResponse)) {
        const reason = extractFeishuError(parsedResponse) ?? (rawResponse.trim() || `HTTP ${response.status}`);
        console.error("[feishu] notification failed", {
          status: response.status,
          reason
        });

        return {
          ok: false,
          enabled: true,
          delivery: "failed",
          message: `飞书通知发送失败：${reason}`
        };
      }

      return {
        ok: true,
        enabled: true,
        delivery: "sent",
        message: "飞书通知发送成功。"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      console.error("[feishu] notification failed", error);
      return {
        ok: false,
        enabled: true,
        delivery: "failed",
        message: `飞书通知发送失败：${message}`
      };
    }
  }

  private formatTime(value: string | Date) {
    return dayjs(value).tz(getAppConfig().timezone).format("YYYY-MM-DD HH:mm:ss");
  }
}

function createFeishuSignature(timestamp: string, secret: string) {
  const stringToSign = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", stringToSign).update("").digest("base64");
}

function parseJsonSafely(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isFeishuSuccess(value: Record<string, unknown> | null) {
  if (!value) {
    return true;
  }

  if (typeof value.code === "number") {
    return value.code === 0;
  }

  if (typeof value.StatusCode === "number") {
    return value.StatusCode === 0;
  }

  return true;
}

function extractFeishuError(value: Record<string, unknown> | null) {
  if (!value) {
    return null;
  }

  if (typeof value.msg === "string" && value.msg.trim()) {
    return value.msg.trim();
  }

  if (typeof value.StatusMessage === "string" && value.StatusMessage.trim()) {
    return value.StatusMessage.trim();
  }

  return null;
}

function formatValue(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : "无";
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "无";
}
