import type {
  ZhihuAccountLibraryExampleRecord,
  ZhihuAccountLibraryPromptContext
} from "../repositories/zhihu-account-library-repository.js";
import type { ZhihuAgentContextDocuments } from "./zhihu-agent-context-service.js";

export type AccountPromptContext = {
  accountId: number;
  accountName: string;
  zhihuUserName: string | null;
};

export function buildTopicTargetProductPromptSuffix(context?: ZhihuAgentContextDocuments | null) {
  return buildTargetProductPromptSuffix("topic", context);
}

export function buildWriterTargetProductPromptSuffix(context?: ZhihuAgentContextDocuments | null) {
  return buildTargetProductPromptSuffix("writer", context);
}

export function buildReviewTargetProductPromptSuffix(context?: ZhihuAgentContextDocuments | null) {
  return buildTargetProductPromptSuffix("review", context);
}

export function buildTopicPromptSuffix(accountContext?: AccountPromptContext | null) {
  const personaName = accountContext?.accountName?.trim();
  if (!personaName) {
    return null;
  }

  const lines = [
    "当前账号上下文：",
    `1. 当前目标账号/人设名称是「${personaName}」。如果基础 prompt 里出现默认人设名如「二牛」，以这个账号为准。`,
    "2. 选题发现、排序、去重和切入角度，都要按这个账号的人设、观察范围和可能经历来判断。",
    "3. 业务目标不变：所有账号仍服务同一推广目标，但不同账号不需要收成同一个选题角度。",
    "4. 当前还是轻量矩阵测试阶段，差异要轻、要像真人。让题目适合这个账号，不要夸张扮演。"
  ];

  if (accountContext?.zhihuUserName?.trim()) {
    lines.push(
      `5. 绑定的知乎用户名是「${accountContext.zhihuUserName.trim()}」。需要时可以当语气参考，但不要硬塞进最终输出。`
    );
  }

  return lines.join("\n");
}

export function buildTopicSoulPromptSuffix(accountSoulMarkdown?: string | null) {
  const markdown = accountSoulMarkdown?.trim();
  if (!markdown) {
    return [
      "账号 Soul 选题规则：",
      "1. 当前 accountSoulMarkdown 为空。只根据运行时账号名和绑定的知乎用户名判断账号契合度。",
      "2. 之后如果提供了 accountSoulMarkdown，选题 Agent 必须把它当作账号定位、读者契合、语气边界和产品提及政策。"
    ].join("\n");
  }

  return [
    "账号 Soul 选题规则：",
    "1. accountSoulMarkdown 是这个知乎账号稳定的身份、读者契合、世界观和产品提及政策。",
    "2. 决定 validity_status、priority、fit_score、recommended_angle、persona_hooks、soft_promo_directive 和 writing_plan 之前，先读 Soul。",
    "3. Soul 不只是文风文档。用它判断这个账号能不能像样地回答这道题、该接哪类读者痛点、什么样的产品提及才自然。",
    "4. 用 product.md + target.md + Soul 主动推断新的选题角度，不要只按固定关键词判断。",
    "5. 任何输出字段都不要引用、暴露或概括 accountSoulMarkdown。",
    `accountSoulMarkdown:\n${markdown}`
  ].join("\n\n");
}

export function buildWriterPromptSuffix(accountContext?: AccountPromptContext | null) {
  const personaName = accountContext?.accountName?.trim();
  if (!personaName) {
    return null;
  }

  const lines = [
    "当前账号上下文：",
    `1. 当前目标账号/人设名称是「${personaName}」。如果基础 prompt 里出现默认人设名如「二牛」，以这个账号为准。`,
    "2. 当前还是轻量矩阵测试阶段，不要为了制造账号差异而重写整套文风。",
    "3. 主要调整语气、观察角度和经历切入方式，回答仍要自然、克制、可信。",
    `4. 除非题目真的需要先建立可信度，否则不要用「我是${personaName}」这种生硬自我介绍开头。`
  ];

  if (accountContext?.zhihuUserName?.trim()) {
    lines.push(
      `5. 绑定的知乎用户名是「${accountContext.zhihuUserName.trim()}」。需要时可以当语气参考，但不必须出现在正文里。`
    );
  }

  return lines.join("\n");
}

export function buildWriterAccountLibraryPromptSuffix(accountLibraryContext?: ZhihuAccountLibraryPromptContext | null) {
  const styleRules = normalizeLibraryMarkdown(accountLibraryContext?.styleRulesMarkdown);
  const structureRules = normalizeLibraryMarkdown(accountLibraryContext?.answerStructureRulesMarkdown);
  const evidenceRules = normalizeLibraryMarkdown(accountLibraryContext?.evidenceRulesMarkdown);
  const goodAnswers = normalizeExampleRecords(accountLibraryContext?.goodAnswers).slice(0, MAX_WRITER_GOOD_ANSWERS);

  if (!styleRules && !structureRules && !evidenceRules && goodAnswers.length === 0) {
    return null;
  }

  return [
    "账号资料库写作规则：",
    "1. 下面这些是这个知乎账号已经沉淀下来的稳定资料。",
    "2. 把它们当约束和正向锚点。学机制，不要抄原句。",
    "3. 动笔前先想清楚：哪一个具体观察、个人判断或小经历，能让这篇读起来像真人知乎回答，而不是通用文章。",
    "4. 不要抄样本的开头、段落骨架、产品过渡或结尾。样本只用来校准密度和自然度。",
    "5. 如果有 evidence_rules.md，正文至少放一个具体证据锚点：可观察事实、场景、取舍、数字区间、用户行为或反例。",
    ...(styleRules ? [`style_rules.md:\n${styleRules}`] : []),
    ...(structureRules ? [`answer_structure_rules.md:\n${structureRules}`] : []),
    ...(evidenceRules ? [`evidence_rules.md:\n${evidenceRules}`] : []),
    ...(goodAnswers.length
      ? [formatExampleSection("good_answers.jsonl（正向锚点，最多 3 条）：", goodAnswers)]
      : [])
  ].join("\n\n");
}

export function buildWriterSoulPromptSuffix(accountSoulMarkdown?: string | null) {
  const markdown = accountSoulMarkdown?.trim();
  if (!markdown) {
    return [
      "账号 Soul 写作规则：",
      "1. 当前 accountSoulMarkdown 为空。只把运行时账号名和绑定的知乎用户名当作轻量身份锚点。",
      "2. 之后如果提供了 accountSoulMarkdown，它会成为这个账号稳定的语气和边界层。"
    ].join("\n");
  }

  return [
    "账号 Soul 写作规则：",
    "1. accountSoulMarkdown 是这篇知乎回答稳定的身份和语气锚点。",
    "2. questionTitle、questionUrl、topicCard 和 revisionFeedback 决定这篇回答什么。Soul 决定谁在说话、什么语气自然、哪些边界不能破。",
    "3. 如果基础 prompt 里有默认人设或通用模板腔，以 Soul 为准。",
    "4. 学 Soul 的节奏、反应方式和措辞偏好，但不要抄范例句式、段落骨架或金句。",
    "5. 最终回答里不要引用或暴露 accountSoulMarkdown。",
    `accountSoulMarkdown:\n${markdown}`
  ].join("\n\n");
}

export function buildReviewAccountLibraryPromptSuffix(accountLibraryContext?: ZhihuAccountLibraryPromptContext | null) {
  const styleRules = normalizeLibraryMarkdown(accountLibraryContext?.styleRulesMarkdown);
  const reviewRubric = normalizeLibraryMarkdown(accountLibraryContext?.reviewRubricMarkdown);
  const badAnswers = normalizeExampleRecords(accountLibraryContext?.badAnswers).slice(0, MAX_REVIEW_BAD_ANSWERS);
  const goodAnswers = normalizeExampleRecords(accountLibraryContext?.goodAnswers).slice(0, MAX_REVIEW_GOOD_ANSWERS);

  if (!styleRules && !reviewRubric && badAnswers.length === 0 && goodAnswers.length === 0) {
    return null;
  }

  return [
    "账号资料库审核规则：",
    "1. 用这些稳定的账号资料判断语气契合、结构契合、自然度，以及反复出现的反模式。",
    "2. 坏样本是反模式锚点。好样本只是正向锚点，不是抄写对象。",
    ...(styleRules ? [`style_rules.md:\n${styleRules}`] : []),
    ...(reviewRubric ? [`review_rubric.md:\n${reviewRubric}`] : []),
    ...(badAnswers.length
      ? [formatExampleSection("bad_answers.jsonl（反模式锚点，最多 3 条）：", badAnswers)]
      : []),
    ...(goodAnswers.length
      ? [formatExampleSection("good_answers.jsonl（正向锚点，最多 1 条）：", goodAnswers)]
      : [])
  ].join("\n\n");
}

export function buildReviewSoulPromptSuffix(accountSoulMarkdown?: string | null) {
  const markdown = accountSoulMarkdown?.trim();
  if (!markdown) {
    return [
      "账号 Soul 审核规则：",
      "1. 当前 accountSoulMarkdown 为空。只根据运行时账号上下文审核人设契合度。",
      "2. 一旦有了 accountSoulMarkdown，它就是账号契合和语气契合的主要参考。"
    ].join("\n");
  }

  return [
    "账号 Soul 审核规则：",
    "1. accountSoulMarkdown 是这个账号稳定的身份和语气锚点。",
    "2. 审核时要看这篇像不像这个知乎账号真的会发，而不只是看它写得漂不漂亮。",
    "3. 人设不符、语气跑偏、假自我介绍、产品提及不自然、触碰禁忌词或硬边界时，写进审核结果。",
    "4. 不要为了“更安全”，要求 Writer 把一篇具体回答改回空泛纪律文、空泛安全口号或空泛账号介绍。",
    "5. 只有草稿明显违反账号边界，或明显不像这个账号时，才按 Soul 直接拦截；其他情况优先给修改意见。",
    "6. 最终审核结果里不要引用或暴露 accountSoulMarkdown。",
    `accountSoulMarkdown:\n${markdown}`
  ].join("\n\n");
}

export function joinPromptSuffixes(...parts: Array<string | null | undefined>) {
  const normalized = parts.map((item) => item?.trim()).filter(Boolean);
  return normalized.length ? normalized.join("\n\n") : null;
}

function buildTargetProductPromptSuffix(
  agent: "topic" | "writer" | "review",
  context?: ZhihuAgentContextDocuments | null
) {
  const targetMarkdown = normalizeContextMarkdown(context?.targetMarkdown);
  const productMarkdown = normalizeContextMarkdown(context?.productMarkdown);

  if (!targetMarkdown && !productMarkdown) {
    return null;
  }

  const agentRule =
    agent === "topic"
      ? [
          "选题 Agent 用法：",
          "1. 用 target.md 判断这道题是否服务业务目标，以及是否适合软广。",
          "2. 只有产品真能解决题目里的某一步时，才用 product.md 选出具体承接点。",
          "3. 如果产品没有自然位置，设 should_include_soft_promo=false。"
        ].join("\n")
      : agent === "writer"
        ? [
            "写作 Agent 用法：",
            "1. 先把知乎问题回答完整，产品提及是第二位。",
            "2. 如果选题 Agent 要求软广，用 product.md 核对真实能力和禁止宣称。",
            "3. 不要引用这些文档，也不要把它们写成功能清单。"
          ].join("\n")
        : [
            "审核 Agent 用法：",
            "1. 先看草稿有没有服从 target.md，再判断该不该出现产品。",
            "2. 用 product.md 抓住能力夸大、硬广、可用率/价格保证，或暗示能绕过官方限制。",
            "3. 对齐偏弱时优先要求修改；只有实质风险或误导时才拦截。"
          ].join("\n");

  return [
    "全局目标/产品上下文：",
    "1. 这些文件是稳定的业务和产品上下文，不是检索材料、范文、文风样本或来源素材。",
    "2. 最终回答里不要引用、暴露、概括或提到这些文件名。",
    "3. 账号 Soul 负责账号语气。target.md 和 product.md 只定义目标、产品范围和软广边界。",
    agentRule,
    targetMarkdown ? `target.md:\n${targetMarkdown}` : null,
    productMarkdown ? `product.md:\n${productMarkdown}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}

const MAX_WRITER_GOOD_ANSWERS = 3;
const MAX_REVIEW_BAD_ANSWERS = 3;
const MAX_REVIEW_GOOD_ANSWERS = 1;
const MAX_EXAMPLE_EXCERPT_CHARS = 320;
const LIBRARY_PLACEHOLDER_MARKERS = [
  "Fill this file with stable voice rules after note-agent apply.",
  "Define opening pace, paragraph density, and section transitions for this account.",
  "Define how this account uses numbers, examples, proof anchors, and caveats.",
  "Review voice fit, structure fit, AI smell, and naturalness for this account."
] as const;

function normalizeLibraryMarkdown(value?: string | null) {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  if (LIBRARY_PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))) {
    return null;
  }

  return normalized;
}

function normalizeContextMarkdown(value?: string | null) {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  return normalized || null;
}

function normalizeExampleRecords(records?: ZhihuAccountLibraryExampleRecord[] | null) {
  return Array.isArray(records) ? records.filter((record) => record.text.trim()) : [];
}

function formatExampleSection(title: string, records: ZhihuAccountLibraryExampleRecord[]) {
  return [
    title,
    ...records.map((record, index) =>
      [
        `样本 ${index + 1}：`,
        `问题：${record.questionTitle || "无标题"}`,
        `备注：${record.notes || "只当参考锚点，不要照抄。"}`,
        `摘录：${truncatePromptExcerpt(record.text)}`
      ].join("\n")
    )
  ].join("\n\n");
}

function truncatePromptExcerpt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_EXAMPLE_EXCERPT_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_EXAMPLE_EXCERPT_CHARS - 3).trimEnd()}...`;
}
