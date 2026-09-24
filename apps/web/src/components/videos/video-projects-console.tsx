"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import type { VideoProjectSummary } from "@zhihu-mvp/shared";
import { getVideoProjects } from "../../lib/api";

export function VideoProjectsConsole() {
  const [projects, setProjects] = useState<VideoProjectSummary[]>([]);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void hydrate();
  }, []);

  function hydrate() {
    return getVideoProjects().then(setProjects).catch((error) => {
      setMessage(error instanceof Error ? error.message : "视频项目加载失败。");
    });
  }

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>项目生产</h2>
          <p className="muted">从命中选题创建项目后，在详情页完成脚本确认、视觉方案确认、资产生产和成片批准。</p>
        </div>
        <button
          className="button button--ghost"
          onClick={() => {
            startTransition(() => {
              void hydrate();
            });
          }}
          disabled={isPending}
        >
          刷新
        </button>
      </header>

      {message ? <section className="card">{message}</section> : null}

      <section className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>标题</th>
              <th>状态</th>
              <th>脚本确认</th>
              <th>视觉确认</th>
              <th>成片</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>
                  <Link href={`/videos/projects/${project.id}`}>{project.title}</Link>
                </td>
                <td>
                  <span className={`status-chip status-chip--${project.status.replaceAll("_", "-")}`}>{project.status}</span>
                </td>
                <td>{project.scriptConfirmedAt ? "已确认" : "待确认"}</td>
                <td>{project.visualRenderPlanConfirmedAt ? "已确认" : "待确认"}</td>
                <td>{project.finalVideoAssetId ? "已生成" : "未生成"}</td>
              </tr>
            ))}
            {projects.length === 0 ? (
              <tr>
                <td colSpan={5}>还没有项目。先去选题看板标记命中并创建项目。</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
