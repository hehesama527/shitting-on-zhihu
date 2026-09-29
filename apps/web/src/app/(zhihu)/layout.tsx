import type { ReactNode } from "react";
import { ProductShell } from "../../components/product-shell";

export default function ZhihuProductLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ProductShell
      tone="zhihu"
      kicker="知乎工作台"
      title="知乎矩阵控制台"
      description="排期、选题、写作审核、发布、账号恢复、提示词管理与运维动作都在这里完成，不与 X 流程混用。"
      navItems={[
        { href: "/zhihu", label: "总览" },
        { href: "/zhihu/schedule", label: "排期" },
        { href: "/zhihu/topics", label: "选题 / 草稿" },
        { href: "/zhihu/publish-jobs", label: "发布任务" },
        { href: "/zhihu/data-agent", label: "数据回收" },
        { href: "/zhihu/prompts", label: "提示词管理" },
        { href: "/zhihu/account", label: "账号" },
        { href: "/zhihu/ops", label: "运维" }
      ]}
      switchHref="/twitter"
      switchLabel="切到 Twitter / X"
    >
      {children}
    </ProductShell>
  );
}
