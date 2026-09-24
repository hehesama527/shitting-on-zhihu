import Link from "next/link";

export default function WorkspacePage() {
  return (
    <main className="workspace-hub">
      <section className="workspace-hero">
        <span className="brand-kicker">矩阵工作台</span>
        <h1>选择你要接管的链路</h1>
        <p className="muted">
          知乎、X 主控链路、X 传统链路，以及热点中心、配图中心、模型中心都在同一套工作台中统一接入。
          业务链路之间相互隔离，但共享中控能力。
        </p>
      </section>

      <section className="workspace-grid">
        <Link href="/zhihu" className="workspace-card workspace-card--zhihu">
          <span className="mini-badge mini-badge--accent">知乎</span>
          <h2>知乎工作台</h2>
          <p>排期、选题、写作、审核、发布、账号恢复和运维诊断都在这里闭环推进。</p>
          <strong>进入知乎链路</strong>
        </Link>

        <Link href="/twitter" className="workspace-card workspace-card--twitter">
          <span className="mini-badge mini-badge--accent">X Workspace</span>
          <h2>X 工作流入口</h2>
          <p>先进入 X 入口页，再按任务主线进入 Traditional 工作台，或去配置中心查看提示词、绑定和作用域。</p>
          <strong>进入 X 工作流入口</strong>
        </Link>

        <Link href="/twitter/traditional" className="workspace-card workspace-card--twitter">
          <span className="mini-badge mini-badge--accent">Direct</span>
          <h2>X 传统链路直达</h2>
          <p>如果你已经确定要处理 Traditional 链路，也可以直接进入工作台总览，不经过 X 入口页分流。</p>
          <strong>直达 Traditional 工作台</strong>
        </Link>

        <Link href="/videos" className="workspace-card workspace-card--hotspots">
          <span className="mini-badge mini-badge--accent">Video Hub</span>
          <h2>视频制作中台</h2>
          <p>平台中立的横版视频生产链路，从选题、脚本、视觉规划到 TTS、配图、字幕和成片合成。</p>
          <strong>进入视频制作中台</strong>
        </Link>
      </section>

      <section className="workspace-hero" style={{ marginTop: "2.25rem" }}>
        <span className="brand-kicker">矩阵辅助</span>
        <h2>中控能力</h2>
        <p className="muted">
          热点中心负责跨账号热点扫描和研究，配图中心负责资产调度，模型中心负责各 agent 的运行时绑定。
          它们属于中控面板，不直接归属某一条内容链路。
        </p>
      </section>

      <section className="workspace-grid">
        <Link href="/hotspots" className="workspace-card workspace-card--hotspots">
          <span className="mini-badge mini-badge--accent">矩阵中控</span>
          <h2>热点中心</h2>
          <p>统一维护 X 热点池、watchlist、补研究和任务桥接，把情报层从具体账号执行层中拆出来。</p>
          <strong>进入热点中心</strong>
        </Link>

        <Link href="/images" className="workspace-card workspace-card--images">
          <span className="mini-badge mini-badge--accent">矩阵辅助</span>
          <h2>配图中心</h2>
          <p>统一管理图片导入、去重、审核、候选图检索和使用记录，供知乎与 X 任务直接绑定 asset。</p>
          <strong>进入配图中心</strong>
        </Link>

        <Link href="/models" className="workspace-card workspace-card--models">
          <span className="mini-badge mini-badge--accent">矩阵中控</span>
          <h2>模型中心</h2>
          <p>给不同 agent 分配不同模型、协议、推理强度和超时，不再让所有链路共享一套默认模型。</p>
          <strong>进入模型中心</strong>
        </Link>
      </section>
    </main>
  );
}
