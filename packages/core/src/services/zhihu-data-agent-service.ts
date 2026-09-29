import { randomUUID } from "node:crypto";
import type { AccountListItem, JobDetail, ZhihuEngagementSnapshot } from "@zhihu-mvp/shared";
import { ZhihuEngagementRepository } from "../repositories/zhihu-engagement-repository.js";
import { BrowserSkillService } from "./browser-skill-service.js";

export class ZhihuDataAgentService {
  constructor(
    private readonly repository: ZhihuEngagementRepository,
    private readonly browserSkillService: BrowserSkillService
  ) {}

  async collect(input: { job: JobDetail; account: AccountListItem }): Promise<ZhihuEngagementSnapshot> {
    const postUrl = input.job.finalUrl;
    if (!postUrl) throw new Error("该发布任务没有可采集的知乎链接。");
    if (!input.account.profileDir) throw new Error("该账号没有浏览器登录态目录。");

    const sessionKey = `data-agent-account-${input.account.id}-job-${input.job.id}`;
    const context = {
      sessionKey,
      profileDir: input.account.profileDir,
      publishJobId: input.job.id,
      stage: "publishing" as const,
      traceGroupId: `data-agent-${input.job.id}-${Date.now()}`,
      agentName: "zhihu-data-agent"
    };

    try {
      await this.browserSkillService.open(context, { url: postUrl });
      await this.browserSkillService.wait(context, { ms: 2500 });
      const snapshot = await this.browserSkillService.snapshot(context);
      const parsed = parseEngagement(snapshot.visibleTexts);
      const result = {
        jobId: input.job.id,
        accountId: input.account.id,
        title: input.job.title,
        postUrl,
        voteCount: parsed.voteCount,
        commentCount: parsed.commentCount,
        comments: parsed.comments,
        collectedAt: new Date().toISOString(),
        status: "succeeded" as const,
        errorMessage: null
      };
      const id = await this.repository.createSnapshot(result);
      return { id, ...result };
    } catch (error) {
      await this.repository.createSnapshot({
        jobId: input.job.id,
        accountId: input.account.id,
        postUrl,
        voteCount: 0,
        commentCount: 0,
        comments: [],
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      await this.browserSkillService.closeSession(sessionKey).catch(() => undefined);
    }
  }
}

function parseEngagement(texts: string[]) {
  const text = texts.join(" ");
  const voteCount = findCount(text, [/赞同\s*(\d[\d,.万]*)/, /点赞\s*(\d[\d,.万]*)/i]);
  const commentCount = findCount(text, [/评论\s*(\d[\d,.万]*)/, /(\d[\d,.万]*)\s*条评论/]);
  return { voteCount, commentCount, comments: [] as ZhihuEngagementSnapshot["comments"] };
}

function findCount(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return parseCount(match[1]);
  }
  return 0;
}

function parseCount(value: string) {
  const normalized = value.replace(/,/g, "");
  if (normalized.endsWith("万")) return Math.round(Number(normalized.slice(0, -1)) * 10000);
  return Number(normalized) || 0;
}
