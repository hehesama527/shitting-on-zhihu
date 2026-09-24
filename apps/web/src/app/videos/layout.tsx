import type { ReactNode } from "react";
import { ProductShell } from "../../components/product-shell";

export default function VideosLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ProductShell
      tone="video"
      kicker="Video Hub"
      title="视频制作中台"
      description="平台中立的视频生产链路：选题、脚本、视觉规划、TTS、素材生产、字幕与横版成片合成。"
      navItems={[
        { href: "/videos", label: "总览" },
        { href: "/videos/topics", label: "选题看板" },
        { href: "/videos/projects", label: "项目生产" },
        { href: "/videos/assets", label: "素材状态" },
        { href: "/videos/feedback", label: "反馈文档" }
      ]}
      switchHref="/models"
      switchLabel="切到模型中心"
    >
      {children}
    </ProductShell>
  );
}
