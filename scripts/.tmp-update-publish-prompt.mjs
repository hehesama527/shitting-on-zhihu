import { getMysqlPool } from "../packages/core/dist/core/src/db/mysql.js";
import { PromptRepository } from "../packages/core/dist/core/src/repositories/prompt-repository.js";
import { getDefaultPromptSeed } from "../packages/core/dist/core/src/prompts/default-prompts.js";

const pool = getMysqlPool();
const repo = new PromptRepository(pool);
const seed = getDefaultPromptSeed("publish_agent");
if (!seed) {
  throw new Error("publish_agent seed missing");
}

const active = await repo.getActivePromptSnapshot("publish_agent");
if (active && active.content === seed.content) {
  console.log(`[skip] publish_agent already active id=${active.promptVersionId} v=${active.version}`);
} else {
  const draftId = await repo.createPromptDraft(
    "publish_agent",
    "Publish Agent v2",
    seed.content,
    "优先点写回答；不要把正文里的「我的回答」当成已回答；targetTexts 原样复制按钮文案。"
  );
  await repo.activatePromptVersion(draftId);
  console.log(`[updated] publish_agent promptVersionId=${draftId}`);
}

const snapshot = await repo.getActivePromptSnapshot("publish_agent");
console.log(
  JSON.stringify(
    {
      id: snapshot?.promptVersionId,
      version: snapshot?.version,
      label: snapshot?.label,
      contentChars: snapshot?.content?.length ?? 0
    },
    null,
    2
  )
);
await pool.end();
