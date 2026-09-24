"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { VideoProjectDetail } from "@zhihu-mvp/shared";
import {
  approveVideoProject,
  confirmVideoRenderPlan,
  confirmVideoScript,
  enqueueVideoAssets,
  enqueueVideoComposition,
  generateVideoRenderPlan,
  generateVideoScript,
  getVideoProject,
  getVideoAssetContentUrl,
  saveVideoRenderPlan,
  saveVideoScript
} from "../../lib/api";

export function VideoProjectDetailConsole({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<VideoProjectDetail | null>(null);
  const [scriptJson, setScriptJson] = useState("");
  const [planJson, setPlanJson] = useState("");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void hydrate().catch((error) => {
      setMessage(error instanceof Error ? error.message : "视频项目加载失败。");
    });
  }, [projectId]);

  const activeVideo = useMemo(
    () => project?.assets.find((asset) => asset.status === "active" && asset.assetType === "video") ?? null,
    [project]
  );

  function withAction(action: () => Promise<VideoProjectDetail | null | void>) {
    startTransition(() => {
      void (async () => {
        try {
          setMessage("");
          const next = await action();
          if (next) {
            setProjectState(next);
          }
        } catch (error) {
          setMessage(error instanceof Error ? error.message : "视频项目操作失败。");
        }
      })();
    });
  }

  async function hydrate() {
    const next = await getVideoProject(projectId);
    if (next) {
      setProjectState(next);
    }
  }

  function setProjectState(next: VideoProjectDetail) {
    setProject(next);
    setScriptJson(JSON.stringify(next.scriptPack ?? {}, null, 2));
    setPlanJson(JSON.stringify(next.visualRenderPlan ?? {}, null, 2));
  }

  function saveScriptFromEditor() {
    withAction(async () => {
      const parsed = JSON.parse(scriptJson);
      return saveVideoScript(projectId, parsed);
    });
  }

  function savePlanFromEditor() {
    withAction(async () => {
      const parsed = JSON.parse(planJson);
      return saveVideoRenderPlan(projectId, parsed);
    });
  }

  if (!project) {
    return <section className="card">{message || "正在加载视频项目..."}</section>;
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>{project.title}</h2>
          <p className="muted">项目 ID：{project.id}</p>
        </div>
        <span className={`status-chip status-chip--${project.status.replaceAll("_", "-")}`}>{project.status}</span>
      </header>

      {message ? <section className="card">{message}</section> : null}

      <section className="grid grid--two">
        <article className="card">
          <h3>确认闸门</h3>
          <p className="helper-text">脚本和视觉方案都确认后，才能进入 TTS、配图和合成。</p>
          <div className="stack--tight">
            <p>脚本：{project.scriptConfirmedAt ? "已确认" : "未确认"}</p>
            <p>视觉方案：{project.visualRenderPlanConfirmedAt ? "已确认" : "未确认"}</p>
            <p>最终成片：{activeVideo?.filePath ?? "未生成"}</p>
          </div>
        </article>
        <article className="card">
          <h3>生产动作</h3>
          <div className="button-row" style={{ marginTop: "1rem" }}>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => generateVideoScript(projectId))}>
              生成脚本
            </button>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => confirmVideoScript(projectId))}>
              确认脚本
            </button>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => generateVideoRenderPlan(projectId))}>
              生成视觉方案
            </button>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => confirmVideoRenderPlan(projectId))}>
              确认视觉方案
            </button>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => enqueueVideoAssets(projectId))}>
              入队素材生产
            </button>
            <button className="button button--small" disabled={isPending} onClick={() => withAction(() => enqueueVideoComposition(projectId))}>
              入队合成
            </button>
            <button className="button button--ghost button--small" disabled={isPending} onClick={() => withAction(() => approveVideoProject(projectId))}>
              批准成片
            </button>
          </div>
        </article>
      </section>

      <section className="grid grid--two">
        <article className="card">
          <div className="card-header">
            <h3>VideoScriptPack</h3>
            <button className="button button--small" onClick={saveScriptFromEditor} disabled={isPending}>保存脚本</button>
          </div>
          <textarea value={scriptJson} onChange={(event) => setScriptJson(event.target.value)} rows={18} style={editorStyle} />
        </article>
        <article className="card">
          <div className="card-header">
            <h3>VisualRenderPlan</h3>
            <button className="button button--small" onClick={savePlanFromEditor} disabled={isPending}>保存方案</button>
          </div>
          <textarea value={planJson} onChange={(event) => setPlanJson(event.target.value)} rows={18} style={editorStyle} />
        </article>
      </section>

      <section className="card">
        <h3>Segments</h3>
        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>标题</th>
                <th>状态</th>
                <th>Builder</th>
                <th>时长</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {project.segments.map((segment) => (
                <tr key={segment.id}>
                  <td>{segment.order}</td>
                  <td>{segment.title}</td>
                  <td><span className={`status-chip status-chip--${segment.status.replaceAll("_", "-")}`}>{segment.status}</span></td>
                  <td>{segment.visualBuilder ?? "未定"}</td>
                  <td>{segment.durationSec}s</td>
                  <td>{segment.errorMessage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>Assets</h3>
        {activeVideo ? (
          <video
            controls
            src={getVideoAssetContentUrl(activeVideo.id)}
            style={{ width: "100%", maxWidth: 960, aspectRatio: "16 / 9", marginTop: "1rem", background: "#111" }}
          />
        ) : null}
        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>状态</th>
                <th>Segment</th>
                <th>路径</th>
                <th>Attempt</th>
              </tr>
            </thead>
            <tbody>
              {project.assets.map((asset) => (
                <tr key={asset.id}>
                  <td>{asset.assetType}</td>
                  <td><span className={`status-chip status-chip--${asset.status}`}>{asset.status}</span></td>
                  <td>{asset.segmentId ?? "project"}</td>
                  <td>{asset.filePath ?? asset.errorMessage ?? ""}</td>
                  <td>{asset.attemptNo}</td>
                </tr>
              ))}
              {project.assets.length === 0 ? (
                <tr>
                  <td colSpan={5}>还没有生产素材。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const editorStyle = {
  width: "100%",
  marginTop: "1rem",
  minHeight: 420,
  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
};
