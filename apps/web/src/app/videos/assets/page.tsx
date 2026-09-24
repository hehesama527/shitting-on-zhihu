import Link from "next/link";
import { getVideoProjects } from "../../../lib/api";

export default async function VideoAssetsPage() {
  let projects;
  try {
    projects = await getVideoProjects();
  } catch (error) {
    return (
      <div className="stack">
        <header className="page-header">
          <div>
            <h2>素材状态</h2>
            <p className="muted">API 暂时不可用。</p>
          </div>
        </header>
        <section className="card">{error instanceof Error ? error.message : "视频中台 API 连接失败。"}</section>
      </div>
    );
  }
  return (
    <div className="stack">
      <header className="page-header">
        <div>
          <h2>素材状态</h2>
          <p className="muted">MVP 素材明细在项目详情页展示；这里用于快速定位正在生产或失败的项目。</p>
        </div>
      </header>
      <section className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th>状态</th>
              <th>错误</th>
              <th>入口</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id}>
                <td>{project.title}</td>
                <td><span className={`status-chip status-chip--${project.status.replaceAll("_", "-")}`}>{project.status}</span></td>
                <td>{project.errorMessage ?? ""}</td>
                <td><Link href={`/videos/projects/${project.id}`}>查看素材</Link></td>
              </tr>
            ))}
            {projects.length === 0 ? (
              <tr>
                <td colSpan={4}>还没有项目素材。</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
