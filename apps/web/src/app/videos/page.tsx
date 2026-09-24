import Link from "next/link";
import { getVideoHubSummary } from "../../lib/api";

export default async function VideosPage() {
  let summary;
  try {
    summary = await getVideoHubSummary();
  } catch (error) {
    return (
      <div className="stack">
        <header className="page-header">
          <div>
            <h2>视频中台总览</h2>
            <p className="muted">API 暂时不可用。</p>
          </div>
          <Link href="/videos/topics" className="button">
            进入选题
          </Link>
        </header>
        <section className="card">{error instanceof Error ? error.message : "视频中台 API 连接失败。"}</section>
      </div>
    );
  }
  const activeProjects = summary.projects.filter((project) => !["approved", "archived"].includes(project.status));
  const pendingTopics = summary.candidates.filter((candidate) => candidate.status === "pending_feedback");
  const readyVideos = summary.projects.filter((project) => project.status === "video_ready");

  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>视频中台总览</h2>
          <p className="muted">MVP 只处理横版 16:9，从选题确认到脚本确认、视觉规划确认、素材生产和最终成片。</p>
        </div>
        <Link href="/videos/topics" className="button">
          进入选题
        </Link>
      </header>

      <section className="grid grid--four">
        <article className="card">
          <p className="helper-text">选题批次</p>
          <strong className="metric-value">{summary.topicBatches.length}</strong>
        </article>
        <article className="card">
          <p className="helper-text">待反馈选题</p>
          <strong className="metric-value">{pendingTopics.length}</strong>
        </article>
        <article className="card">
          <p className="helper-text">生产中项目</p>
          <strong className="metric-value">{activeProjects.length}</strong>
        </article>
        <article className="card">
          <p className="helper-text">待批准成片</p>
          <strong className="metric-value">{readyVideos.length}</strong>
        </article>
      </section>

      <section className="card">
        <div className="card-header">
          <h3>最近项目</h3>
          <Link href="/videos/projects" className="button button--ghost button--small">
            全部项目
          </Link>
        </div>
        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>规格</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {summary.projects.slice(0, 8).map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link href={`/videos/projects/${project.id}`}>{project.title}</Link>
                  </td>
                  <td>
                    <span className={`status-chip status-chip--${project.status.replaceAll("_", "-")}`}>{project.status}</span>
                  </td>
                  <td>{project.aspectRatio}</td>
                  <td>{new Date(project.updatedAt).toLocaleString("zh-CN")}</td>
                </tr>
              ))}
              {summary.projects.length === 0 ? (
                <tr>
                  <td colSpan={4}>还没有视频项目。</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
