"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { VideoTargetPlatform, VideoTopicBatchSummary, VideoTopicCandidateSummary } from "@zhihu-mvp/shared";
import {
  createVideoProject,
  createVideoTopicBatch,
  getVideoTopicBatches,
  getVideoTopicCandidates,
  refillVideoTopicBatch,
  saveVideoTopicFeedback,
  scoreVideoHotspot
} from "../../lib/api";

const decisions = [
  { value: "hit", label: "命中" },
  { value: "miss", label: "未命中" },
  { value: "not_now", label: "暂不做" },
  { value: "duplicate", label: "重复" },
  { value: "risky", label: "有风险" }
] as const;

export function VideoTopicsConsole() {
  const [batches, setBatches] = useState<VideoTopicBatchSummary[]>([]);
  const [candidates, setCandidates] = useState<VideoTopicCandidateSummary[]>([]);
  const [productBrief, setProductBrief] = useState("");
  const [audience, setAudience] = useState("");
  const [hotspotJson, setHotspotJson] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [targetPlatform, setTargetPlatform] = useState<VideoTargetPlatform>("agnostic");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void hydrate().catch((error) => {
      setMessage(error instanceof Error ? error.message : "视频选题加载失败。");
    });
  }, []);

  function withAction(action: () => Promise<void>) {
    startTransition(() => {
      void (async () => {
        try {
          setMessage("");
          await action();
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "视频选题操作失败。");
        }
      })();
    });
  }

  async function hydrate() {
    const [nextBatches, nextCandidates] = await Promise.all([getVideoTopicBatches(), getVideoTopicCandidates()]);
    setBatches(nextBatches);
    setCandidates(nextCandidates);
  }

  function generateBatch() {
    withAction(async () => {
      await createVideoTopicBatch({
        source: "manual",
        targetPlatform,
        targetCount,
        productBrief,
        audience
      });
      await hydrate();
      setMessage("选题批次已生成，并已触发飞书提醒。");
    });
  }

  function continueBatch(batchId: string) {
    withAction(async () => {
      await refillVideoTopicBatch(batchId, {
        targetCount,
        userRequirement: "参考本轮未命中反馈继续补题。"
      });
      await hydrate();
      setMessage("已提交补题。");
    });
  }

  function scoreHotspot() {
    withAction(async () => {
      const hotspot = hotspotJson.trim() ? JSON.parse(hotspotJson) : {};
      const result = await scoreVideoHotspot({
        hotspot,
        productBrief,
        audience,
        targetPlatform
      });
      await hydrate();
      setMessage(`热点评分 ${result.score}，${result.accepted ? "已生成候选" : "未达到入库阈值"}。${result.reason}`);
    });
  }

  function feedback(candidateId: string, decision: (typeof decisions)[number]["value"]) {
    withAction(async () => {
      await saveVideoTopicFeedback(candidateId, { decision });
      await hydrate();
    });
  }

  function makeProject(candidate: VideoTopicCandidateSummary) {
    withAction(async () => {
      const project = await createVideoProject({ topicCandidateId: candidate.id, title: candidate.title });
      await hydrate();
      setMessage(project ? `已创建视频项目：${project.title}` : "项目创建完成。");
    });
  }

  const selectedCount = candidates.filter((candidate) => candidate.status === "selected").length;
  const latestBatch = batches[0] ?? null;

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>选题看板</h2>
          <p className="muted">生成横版视频选题，收集命中反馈。命中后才能创建视频项目。</p>
        </div>
        <button className="button" onClick={generateBatch} disabled={isPending}>
          {isPending ? "处理中" : "生成选题"}
        </button>
      </header>

      <section className="card">
        <div className="grid grid--three">
          <label className="field">
            <span>目标数量</span>
            <input type="number" min={1} max={20} value={targetCount} onChange={(event) => setTargetCount(Number(event.target.value))} />
          </label>
          <label className="field">
            <span>目标平台</span>
            <select value={targetPlatform} onChange={(event) => setTargetPlatform(event.target.value as VideoTargetPlatform)}>
              <option value="agnostic">agnostic</option>
              <option value="x">x</option>
              <option value="zhihu">zhihu</option>
              <option value="bilibili">bilibili</option>
              <option value="manual">manual</option>
            </select>
          </label>
          <div className="field">
            <span>本轮命中数</span>
            <strong className="metric-value">{selectedCount}</strong>
          </div>
        </div>
        <label className="field">
          <span>产品/内容 brief</span>
          <textarea value={productBrief} onChange={(event) => setProductBrief(event.target.value)} rows={3} />
        </label>
        <label className="field">
          <span>目标受众</span>
          <textarea value={audience} onChange={(event) => setAudience(event.target.value)} rows={2} />
        </label>
        <label className="field">
          <span>热点 JSON</span>
          <textarea value={hotspotJson} onChange={(event) => setHotspotJson(event.target.value)} rows={3} />
        </label>
        <button className="button button--ghost" onClick={scoreHotspot} disabled={isPending || !hotspotJson.trim()}>
          热点评分
        </button>
        {message ? <p className="helper-text">{message}</p> : null}
      </section>

      {latestBatch && selectedCount < 10 ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h3>当前命中不足 10 个</h3>
              <p className="muted">可以先进入下一步，也可以让 TopicAgent 参考反馈继续补题。</p>
            </div>
            <div className="button-row">
              <Link href="/videos/projects" className="button button--ghost">进入下一步</Link>
              <button className="button" onClick={() => continueBatch(latestBatch.id)} disabled={isPending}>继续选题</button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="grid">
        {candidates.map((candidate) => (
          <article key={candidate.id} className="card">
            <div className="card-header">
              <div>
                <span className={`status-chip status-chip--${candidate.status.replaceAll("_", "-")}`}>{candidate.status}</span>
                <h3 style={{ marginTop: "0.75rem" }}>{candidate.title}</h3>
              </div>
              <strong>{candidate.score}</strong>
            </div>
            <p>{candidate.brief}</p>
            <p className="muted">{candidate.angle}</p>
            <div className="button-row">
              {decisions.map((decision) => (
                <button
                  key={decision.value}
                  className={decision.value === "hit" ? "button button--small" : "button button--ghost button--small"}
                  onClick={() => feedback(candidate.id, decision.value)}
                  disabled={isPending}
                >
                  {decision.label}
                </button>
              ))}
              <button
                className="button button--small"
                onClick={() => makeProject(candidate)}
                disabled={isPending || (candidate.status !== "selected" && candidate.latestFeedbackDecision !== "hit")}
              >
                建项目
              </button>
            </div>
          </article>
        ))}
        {candidates.length === 0 ? <section className="card">还没有选题候选。</section> : null}
      </section>
    </div>
  );
}
