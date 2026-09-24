import type { ReactNode } from "react";
import { ProductShell } from "../../components/product-shell";

export default function ModelsLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ProductShell
      tone="models"
      kicker="中控矩阵"
      title="模型中心"
      description="统一维护模型库、配图运行时和不同 Agent 的绑定关系。模型基础资料与绑定关系拆开管理，避免做成单页堆叠式设置。"
      navItems={[
        { href: "/models", label: "模型库" },
        { href: "/models/images", label: "配图中心" },
        { href: "/models/zhihu", label: "知乎绑定" },
        { href: "/models/x", label: "X 绑定" },
        { href: "/models/video", label: "Video Hub" },
        { href: "/models/system", label: "系统绑定" }
      ]}
      switchHref="/images"
      switchLabel="切到图库资产"
    >
      {children}
    </ProductShell>
  );
}
