// 2026-09 产品定位从 CryptoPathX 切换为 dudu 中转站。
//
// 和历史上 scripts/update-zhihu-soft-promo-workflow-prompts.mjs 用"文本替换"的做法不同，
// 这个脚本直接用 packages/core/src/prompts/default-prompts.ts 里已经改好的 dudu 版本
// topic_agent / writer_agent / review_agent 全文内容，创建新的 prompt 版本并激活。
//
// 之所以不做增量文本替换：CryptoPathX 版本的 Prompt 里有大量"交易黑话/案例结构"层面的
// 领域重写（止盈止损、仓位、资金费率 -> 限流、Token 计费、接入成本 这种整段重写），
// 不是简单的品牌名替换，用 replaceOnce/字符串匹配很容易因为线上 active 版本文案已经
// 和 default-prompts.ts 的种子文本不完全一致而失败或替换不完整。直接整体替换成新的
// 完整版本内容，更稳妥、更好核对。
//
// 旧版本不会被删除：prompt_versions.status 会自动把上一个 active 版本改成 archived，
// 随时可以在 prompt_versions 表里查到，也可以再手动 activate 回去。
//
// 用法（需要先 `npm run build`，脚本读取的是编译产物 dist/）：
//   node scripts/update-zhihu-dudu-prompts.mjs
//
// 注意：
// 1. 运行前请确认连接的是你想改的那个环境（测试库 / 生产库），本脚本本身不做环境校验。
// 2. 知乎生产后端目前不建议改动，请先在测试环境跑通、确认内容质量之后，再决定要不要
//    对生产库执行这个脚本。
// 3. 如果当前 active 版本内容已经和新种子内容完全一致，脚本会跳过，不会重复建版本。

import { getMysqlPool } from "../packages/core/dist/core/src/db/mysql.js";
import { PromptRepository } from "../packages/core/dist/core/src/repositories/prompt-repository.js";
import { getDefaultPromptSeed } from "../packages/core/dist/core/src/prompts/default-prompts.js";

const AGENTS = [
  { name: "topic_agent", label: "选题 Agent v16 - Dudu 中转站", notes: "2026-09 选题只做大模型中转，产品名 Dudu 中转站；软广时交代加粗引导文末 GitHub router-list。" },
  { name: "writer_agent", label: "写作 Agent v17 - Dudu 中转站", notes: "2026-09 产品名 Dudu 中转站；正文用加粗句引导文末 GitHub router-list；禁止 API 域名。" },
  { name: "review_agent", label: "审核 Agent v5 - Dudu 中转站", notes: "2026-09 拦截 dududu.cloud；提到 Dudu 时要求加粗引导文末 GitHub router-list。" }
];

const pool = getMysqlPool();
const repo = new PromptRepository(pool);

async function migrateAgent({ name, label, notes }) {
  const seed = getDefaultPromptSeed(name);
  if (!seed) {
    console.log(`[skip] ${name}: default-prompts.ts 里没有找到对应的种子内容，跳过。`);
    return null;
  }

  const active = await repo.getActivePromptSnapshot(name);
  if (active && active.content === seed.content) {
    console.log(`[skip] ${name}: active 版本内容已经和新种子一致，跳过。`);
    return null;
  }

  const draftId = await repo.createPromptDraft(name, label, seed.content, notes);
  await repo.activatePromptVersion(draftId);
  console.log(`[updated] ${name}: 已创建新版本并激活 (promptVersionId=${draftId})`);
  return draftId;
}

try {
  for (const agent of AGENTS) {
    await migrateAgent(agent);
  }

  const summary = {};
  for (const agent of AGENTS) {
    const snapshot = await repo.getActivePromptSnapshot(agent.name);
    summary[agent.name] = {
      id: snapshot?.promptVersionId,
      version: snapshot?.version,
      label: snapshot?.label
    };
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}
