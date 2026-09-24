import fs from "node:fs/promises";
import path from "node:path";
import { getAppConfig } from "../config/env.js";

export type ZhihuAgentContextDocuments = {
  targetMarkdown: string | null;
  productMarkdown: string | null;
  targetPath: string;
  productPath: string;
};

export class ZhihuAgentContextService {
  async ensureDocuments(): Promise<ZhihuAgentContextDocuments> {
    const targetPath = this.getTargetPath();
    const productPath = this.getProductPath();

    await Promise.all([
      fs.mkdir(path.dirname(targetPath), { recursive: true }),
      fs.mkdir(path.dirname(productPath), { recursive: true })
    ]);

    const [targetMarkdown, productMarkdown] = await Promise.all([
      ensureMarkdownFile(targetPath, DEFAULT_TARGET_MARKDOWN_DUDU),
      ensureMarkdownFile(productPath, DEFAULT_PRODUCT_MARKDOWN_DUDU)
    ]);

    return {
      targetMarkdown,
      productMarkdown,
      targetPath,
      productPath
    };
  }

  private getTargetPath() {
    const override = normalizeOptionalPath(process.env.ZHIHU_TARGET_CONTEXT_PATH);
    if (override) {
      return override;
    }

    return path.join(this.getContextDirectory(), "target.md");
  }

  private getProductPath() {
    const override = normalizeOptionalPath(process.env.ZHIHU_PRODUCT_CONTEXT_PATH);
    if (override) {
      return override;
    }

    return path.join(this.getContextDirectory(), "product.md");
  }

  private getContextDirectory() {
    const override = normalizeOptionalPath(process.env.ZHIHU_AGENT_CONTEXT_DIR);
    if (override) {
      return override;
    }

    return path.join(getAppConfig().dataDir, "zhihu-agent-context");
  }
}

async function ensureMarkdownFile(filePath: string, defaultContent: string) {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    return normalizeMarkdown(existing);
  } catch {
    await fs.writeFile(filePath, defaultContent, "utf8");
    return normalizeMarkdown(defaultContent);
  }
}

function normalizeMarkdown(value: string) {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized || null;
}

function normalizeOptionalPath(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

// ============================================================================
// Dudu 中转站（当前生效的默认产品定位）
// ============================================================================
// 2026-09 产品定位从 CryptoPathX（加密货币策略回测平台）切换为 Dudu 中转站
// （大模型 API 中转服务，定位类似 OpenRouter，专注 GPT 系列模型和 Claude Code）。
// 对外产品名写 Dudu 中转站；知乎正文不要出现 api.dududu.cloud；
// 提到产品时，正文用加粗句引导文末 GitHub 仓库 router-list，https 链接只放参考文献。
// 这两个常量只在 data/zhihu-agent-context/target.md 或 product.md 文件不存在时
// 才会被写入磁盘作为初始内容（见 ensureMarkdownFile）。已存在的文件不会被覆盖。
//
// 重要教训（2026-09-07）：刚做 dudu 切换时只改了这两个常量，没意识到
// data/zhihu-agent-context/target.md 和 product.md 早就存在（旧的 CryptoPathX 内容，
// 2026-04-28 写入），ensureMarkdownFile 因此从未覆盖它们，导致选题预筛/校验一直在用
// 旧的"币圈交易"定位判断有效性（比如把加密货币 FOMO 题判为 valid，把 GPT-6 模型评测题
// 判为 invalid）。已经手动把磁盘上的两个文件同步成下面的 DUDU 版本内容，旧文件备份在
// docs/archive/cryptopathx-legacy-2026-09/target.md.cryptopathx-backup 和
// product.md.cryptopathx-backup。以后再改这两个常量时，记得同时手动同步磁盘文件，
// 不能只指望 ensureMarkdownFile。
const DEFAULT_TARGET_MARKDOWN_DUDU = `# Target

## Business Goal
我们写知乎回答，是为了让正在用/想用 GPT、Claude Code、Codex 做编程和内容工作的读者理解：直连官方 API 经常卡在访问、支付、价格这几个具体问题上，Dudu 中转站是解决这些具体问题的一个选项。Dudu 只在能自然承接这些痛点时出现，不为了推广硬提。

## Target Reader
- 对 AI 辅助编程、大模型 API 接入、Claude Code、GPT、Codex 有兴趣的中文知乎读者。
- 已经在用或正准备用这些工具，但被访问不稳定、支付麻烦、官方价格贵卡住的人。
- 不要求是资深工程师，独立开发者、学生、自由职业者都算目标读者。

## Content Goal
- 先把知乎问题回答完整，再考虑是否自然提及 Dudu 中转站。
- 给出可操作的判断路径：什么时候该用官方直连，什么时候中转更划算/更省心。
- 让产品成为解决方案里的一个选项，而不是文章目的本身。

## Soft-Promo Principle
- 不为每篇文章强行植入 Dudu。
- 只有当题目自然涉及"怎么稳定用上 GPT/Claude Code""API 太贵/太不稳定怎么办""中转服务靠不靠谱"时才提及。
- 产品提及必须短、具体、克制，放在自然的工作流节点里。
- 账号内容需要有留白，不要每一条都带软广。整体节奏可以按约 10 条里 7 条自然带产品、3 条纯分享/纯经验/纯观点来控制。
- Topic Agent 即使发现某个题目可以勉强承接产品，也要判断这篇是否更适合作为"无产品提及"的信任内容；工具选型心得、踩坑复盘、开发者常识、观点判断类题可以承担留白内容。
- 内容重心只放在大模型 API 中转、访问稳定性、调用成本、限流报错、代理/中转选型、官方直连取舍、Claude Code / Codex 实际使用。
- 工具对比/选型类题可以回复，也可以自然加入软广。重点不是写成产品测评合集，而是讲清楚不同方案各自的适用场景和局限。
- AI 辅助编程类题可以回复，也可以自然加入软广。重点是怎么把 Claude Code / GPT 用得更顺手、更省钱、更稳定。
- 提到 Dudu 时，产品段用一句 **加粗** 引导，点名文末 GitHub 仓库 「router-list」 并写清打开后看什么；https 链接只放文末「参考文献」，不要在段落中间塞链接，也不要在知乎正文放 API 域名。

## Non-Target Topics
- 和 GPT / Codex / Claude Code / 大模型 API 接入、调用成本、访问稳定性、开发者工作流无关的题目，一律 invalid 或 SKIP。
- 不要为了流量去接无关热点。

## Success Criteria
- 读者先觉得答案解决了问题，其次才注意到工具。
- 产品能力和题目痛点之间有明确承接点。
- 没有夸大宣称、没有暗示违规/破解、没有价格数字硬广、没有直接 API 域名。
- 即使删掉产品名，文章主体仍然成立、有用、像知乎真人回答。

## Agent Rules
- Topic Agent 判断这个选题是否适合自然软广，并给出具体承接点。
- Topic Agent 必须优先考虑实际使用/想用 GPT、Claude Code、Codex 的开发者选题，不要把纯理论科普当作主要候选。
- Topic Agent 需要维护内容节奏：不要连续把所有有效题都判定为 should_include_soft_promo=true；没有明确的访问/成本/稳定性承接必要时，优先留白。
- Writer Agent 只在 Topic Agent 要求时自然提及产品，且必须先回答问题。提到产品时，正文用加粗句引导文末 GitHub 仓库 「router-list」，https 链接只放参考文献。
- Review Agent 检查产品提及是否真实、克制、相关，拦截夸大、硬广、缺少加粗引导，以及 api.dududu.cloud 这类直接地址。
- Note Agent 不使用本文档学习账号语气，避免污染 Soul。
- Publish Agent 不需要本文档。`;

const DEFAULT_PRODUCT_MARKDOWN_DUDU = `# Dudu 中转站 Product Context

## One-Line Positioning
Dudu 中转站是一个大模型 API 中转服务，定位类似 OpenRouter，目前专注做好两条线：GPT 系列模型和 Claude Code。

一句话卖点：不用直连官方，也能把 GPT、Claude Code 用得更稳定、更划算。

## Official Name And Link Policy
- 对外产品名写 **Dudu 中转站**，短称可以写 Dudu。
- 真实接入地址是 api.dududu.cloud，但**知乎正文、标题、摘要、评论里都不要出现这个域名**，也不要出现 dududu.cloud。
- 正文里只写产品名，不要把 https 链接塞进段落当中当广告。
- 只要正文提到了 Dudu 中转站或 Dudu，产品段必须有一句 **加粗** 引导，点名文末 GitHub 仓库 「router-list」，并写清打开后看费率、手动教程或 CC Switch 中与本题最相关的一项。
- 把这个 GitHub 仓库当成公开的中转对照列表来引用，不要写成官方文档站，也不要写成“点这里充值/注册”。
- 参考文献放在全文最后，单独成段，不要写成结尾硬广。推荐格式：
  **对照费率和接入步骤：**
  https://github.com/hehesama527/router-list

## Target Users
- 在用或想用 GPT、Claude Code、Codex 做编程、写作、辅助工作的中文开发者。
- 被官方渠道的访问稳定性、支付方式、价格卡住的人。
- 独立开发者、小团队、学生党，对成本敏感，不想自己搭建和维护中转服务的人。

## Current Stage
早期推广阶段，具体上线细节、控制台形态、计费方式以实际产品为准，内容中不展开介绍未确认的功能细节。

## Core Value
把"直连官方 API 麻烦、贵、不稳定"变成"一个中转入口，接入简单、价格更划算"。

## Core Features
- 中转 GPT 系列模型和 Claude Code 的调用能力。
- 接入方式和官方接口保持一致的使用体验，降低迁移成本。
- 价格比官方直连更划算（具体幅度不量化，见下方 Pricing Framing）。

## Pricing Framing
- 只说"价格远低于官方直连成本""比官方划算不少"，不在正文里给出具体折扣数字或计算方式。
- 不写"永久低价""限时价格"这类营销钩子。
- 不承诺价格永远不变。

## Competitive Differentiation

### Compared With OpenRouter
- OpenRouter 是托管聚合，模型覆盖广，但对国内用户来说，访问和支付仍是常见门槛。
- Dudu 只做 GPT 和 Claude Code 两条线，换来的是接入更方便、价格更划算。
- 内容表达：可以说"如果你的需求就是 GPT 和 Claude Code，不需要 OpenRouter 那么全的模型清单，Dudu 这种专注做这两条线的中转会更省心。"

### Compared With Self-Hosted Gateways
- New API 是国内常见自建中转后台，适合想自己管 Key、额度和多用户分发的人。
- LiteLLM 更偏有运维能力的团队做工程化网关。
- 内容表达：可以说"如果你愿意自己搭、自己维护，New API / LiteLLM 会更灵活；如果只是想稳定用上 GPT 和 Claude Code，不想自己运维，Dudu 更省事。"

## Current Landscape (2026-09)
正文默认按当下写，不要把 GPT-4、GPT-4o、o1、Claude 3.5 写成当前主力。只有读者在回忆旧版本时才提，并写清是以前。

- OpenAI 侧常见：GPT-6 Astra（当前旗舰）、GPT-5.6 Sol / Terra / Luna；编程侧常见产品是 Codex。付费档已陆续可用，免费档通常没有 Astra。
- Anthropic 侧常见：Claude Fable 5.1、Claude Opus 5、Claude Sonnet 5、Claude Haiku 4.5；编程侧常见产品是 Claude Code。
- Dudu 只承诺 GPT 系列 + Claude Code 两条产品线。不要把 Codex 客户端、某个模型的专属能力、精确官方价目写成 Dudu 功能。
- 不要编造具体官方价格、限流阈值、上下文窗口数字。

## Best-Fit Content Angles
这些角度适合在知乎回答中自然提及 Dudu 中转站：

- 国内怎么稳定用上 Claude Code / Codex / GPT API。
- 用 AI 编程时官方 API 访问不稳定/太贵怎么办。
- 个人开发者怎么控制 AI API 调用成本。
- Claude Code / Codex 值不值得用、怎么上手、怎么配置。
- 怎么判断一个 API 中转/代理服务靠不靠谱。
- GPT / Claude 接口选型：官方直连 vs 中转，什么场景该选哪个。

## Safe Mention Pattern
当 Topic Agent 判断可以自然软性提及时，Writer 应该把 Dudu 放在"怎么解决访问/成本问题"这一步，而不是写成广告。

推荐表达方向：
- "如果官方直连总卡，可以考虑 Dudu 这类中转，用起来和官方接口差不多，但访问更稳、价格更划算。"
- "价格上会比官方直连划算不少，具体幅度看实际用量，这里不细算。"
- 正文只提产品名。产品段用一句 **加粗** 引导，点名文末 GitHub 仓库 「router-list」 并写清打开后看什么；https 链接只放文末参考文献，不要写进中间段落。
- 产品段落要短，放在"怎么用起来更省心"这一步，不要写成功能清单或广告合集。

## Forbidden Claims
- 不说"绕过官方限制""破解官方接口""无视官方风控""无限调用"。
- 不承诺 100% 可用、无限并发、永不封号、永不涨价。
- 不给具体折扣百分比或计算公式当卖点主句。
- 不暗示与 OpenAI/Anthropic 有官方合作关系，不冒充官方。
- 不做与产品无关的夸大承诺。
- 正文不要出现 api.dududu.cloud、dududu.cloud，或其他直接 API 域名。

## Product Limitations
- 目前只支持 GPT 系列模型和 Claude Code，没有覆盖其它模型/供应商。
- 内容中不展开具体计费规则、并发上限、SLA 细节，避免和实际运营规则产生偏差。
- 不确定的产品细节（控制台、多 Key 管理、团队协作等）在正文中不主动展开，避免说错。`;

// ============================================================================
// CryptoPathX（历史存档，2026-09 之前生效，当前不再作为默认值使用）
// ============================================================================
// 保留这两个常量只是为了不丢失历史内容；ensureDocuments() 已经改成使用上面的
// DUDU 版本。如果以后需要恢复 CryptoPathX 定位，把 ensureDocuments() 里的调用
// 换回这两个常量即可。docs/archive/cryptopathx-legacy-2026-09/ 下也有完整快照。
const DEFAULT_TARGET_MARKDOWN_CRYPTOPATHX = `# Target

## Business Goal
我们写知乎回答，是为了让目标读者理解：币圈、交易和量化判断不能只靠感觉，应该先做验证、回测、复盘和风险控制。CryptoPathX 只在能自然帮助这些步骤时出现。

## Target Reader
- 对币圈、交易策略、市场判断、量化验证有兴趣的中文知乎读者。
- 已经有交易或研究需求，但容易凭感觉、单一指标或短期情绪做决策的人。
- 不一定会写代码，但愿意用工具把想法变成可复盘流程的人。

## Content Goal
- 先把知乎问题回答完整，再考虑是否自然提及产品。
- 给出可操作的判断路径、验证方法、风险边界和复盘思路。
- 让产品成为方法链路里的一个工具选择，而不是文章目的本身。

## Soft-Promo Principle
- 不为每篇文章强行植入 CryptoPathX。
- 只有当题目自然涉及验证、回测、策略构建、多周期观察、多币种交叉、历史相似走势、复盘或风控时，才考虑提及 CryptoPathX。
- 产品提及必须短、具体、克制，放在自然的工作流节点里。
- 账号内容需要有留白，不要每一条都带软广。整体节奏可以按约 10 条里 7 条自然带产品、3 条纯分享/纯经验/纯观点来控制。
- Topic Agent 即使发现某个题目可以勉强承接产品，也要判断这篇是否更适合作为“无产品提及”的信任内容；泛交易心态、踩坑复盘、币圈常识、观点判断类题可以承担留白内容。
- 内容重心优先放在币圈交易者身上：炒币、合约、杠杆、行情结构、K 线形态、交易心态、风控、复盘和踩坑经验，比纯量化工作流更重要。
- 形态识别/技术形态教学类题可以回复，也可以自然加入软广。重点不是写成指标百科，而是讲如何识别形态、为什么容易误判、如何用历史数据或形态分析工具做验证。
- AI 和交易联动类题可以回复，也可以自然加入软广。重点是 AI 辅助解释指标、生成策略条件、解读回测结果、发现风险点，而不是宣称 AI 能预测行情或替用户交易。
- 纯量化工作流题不再作为主要选题方向。量化策略上线、深度优化、参数调优、研究 pipeline、团队研发效率这类题，如果没有明确币圈交易痛点，应跳过或降到很低优先级。
- 泛交易心态题可以作为纯经验分享存在，例如外汇交易者亏损、如何避免成为韭菜、人性和纪律问题；这类题不需要强行加入 CryptoPathX，除非题目本身明确问工具、回测、监控、策略验证或复盘系统。

## Success Criteria
- 读者先觉得答案解决了问题，其次才注意到工具。
- 产品能力和题目痛点之间有明确承接点。
- 没有收益承诺、喊单暗示、交易所推荐或过度营销。
- 即使删掉产品名，文章主体仍然成立、有用、像知乎真人回答。

## Agent Rules
- Topic Agent 判断这个选题是否适合自然软广，并给出具体承接点。
- Topic Agent 必须优先考虑币圈和交易经验类选题，不要再把纯量化工作流作为主要候选。
- Topic Agent 对泛交易心态题可以判定有效，但默认应让 Writer 作为纯分享回答，不强制软广。
- Topic Agent 需要维护内容节奏：不要连续把所有有效题都判定为 should_include_soft_promo=true；没有明确工具/验证/监控/回测承接必要时，优先留白。
- Topic Agent 对形态识别教学、K 线形态、量价结构、AI 辅助交易判断、AI 解读回测这类题，应视为产品可自然承接的重点方向，可以要求 Writer 轻量提及 CryptoPathX。
- Writer Agent 只在 Topic Agent 要求时自然提及产品，且必须先回答问题。
- Review Agent 检查产品提及是否真实、克制、相关，并拦截夸大或硬广。
- Note Agent 不使用本文档学习账号语气，避免污染 Soul。
- Publish Agent 不需要本文档。`;

const DEFAULT_PRODUCT_MARKDOWN_CRYPTOPATHX = `# CryptoPathX Product Context

## One-Line Positioning
CryptoPathX 是一个面向加密货币交易者的策略回测与 AI 辅助决策平台。

一句话卖点：先验证，再交易。不要用真金白银直接试错。

## Target Users
- 有一定技术分析基础的加密货币交易者，不是纯小白用户。
- 希望用历史数据验证交易想法、降低主观决策风险的人。
- 会看 K 线和常见指标，但不一定会写代码或搭建专业回测框架的人。
- 需要把交易思路、指标条件、止盈止损和仓位规则整理成可复盘流程的人。

## Target User Segments

### Experienced Traders
- 有自己的交易思路、盘感或形态判断，但缺少方便的验证工具。
- 常见问题是“这个想法到底行不行”“这次回撤是正常波动还是策略失效”。
- 内容承接：策略验证、回测复盘、最大回撤、盈亏比、样本外失效。

### AI-Curious Traders
- 想用自然语言描述策略，不想从代码或复杂公式开始。
- 常见问题是“AI 能不能帮我把想法变成策略条件”“AI 能不能帮我看懂回测结果”。
- 内容承接：AI 自然语言生成策略、AI 解读回测、AI 对话助手。

### Indicator Learners
- 想学 RSI、MACD、均线、量价结构、K 线形态，但需要低门槛解释和验证。
- 常见问题是“这个指标到底有没有用”“这个形态为什么一追就错”。
- 内容承接：80+ 技术指标、形态识别、K 线可视化、历史验证。

### Busy Traders
- 有交易需求，但没有时间持续盯盘。
- 常见问题是“我不想一直盯着图表，条件到了能不能提醒我”。
- 内容承接：信号自动监控、条件触发、飞书推送。

## Current Stage
- Beta 已上线。
- 核心回测引擎和 AI Agent 一、二期已完成。
- 生产环境域名：cryptopathx.com。

## Core Value
CryptoPathX 帮助用户把“我感觉这个策略可行”变成“这个策略在历史数据、不同周期和明确风控参数下是否经得起验证”。

它不是替用户预测行情，也不是替用户下单，而是降低策略验证、回测分析和复盘优化的门槛。

## Core Features

### Strategy Backtesting
- 用户可以自定义买入、卖出条件。
- 支持技术指标、表达式和自定义指标组合。
- 支持选择币种和时间周期后运行历史回测。
- 输出交易记录、收益曲线、胜率、最大回撤等结果。
- 支持专业级回测：80+ 指标、多周期、自定义买卖条件。
- 典型流程：创建策略 -> 配置条件 -> 选择币种和周期 -> 运行回测 -> 查看收益报告。

### Technical Analysis And K-Line Visualization
- 提供专业 K 线图表和技术指标叠加，当前定位是专业可视化能力。
- 支持双引擎 K 线图表。
- 支持 80+ TA-Lib 技术指标。
- 支持多个常用周期，例如 1min、5min、15min、1h、4h、1d。
- 适合用来观察指标、价格结构、趋势变化和策略触发点。

### AI Strategy Assistant
- 用自然语言解释 RSI、MACD 等指标和策略逻辑。
- 根据用户当前页面和操作上下文给出引导。
- 支持自然语言生成策略条件，例如“帮我做一个 RSI 超卖买入的策略”。
- 自动解读回测结果，解释收益、胜率、最大回撤等关键指标。
- 基于回测结果给出优化建议，支持多轮对话和回滚。
- 这是当前最重要的差异化传播点之一：AI + 回测 + 可视化结合，而不是单纯聊天或单纯图表。

### Signal Monitoring
- 用户可以为特定币种和策略设置监控条件。
- 系统通过定时任务扫描行情，条件满足时触发通知。
- 当前支持飞书机器人推送。
- 这是定时轮询，不是 WebSocket 实时行情推送。
- 适合忙碌型交易者：不用长期盯盘，但关键条件触发时可以收到提醒。

### Pattern Analysis
- 检测经典量价形态，例如放量突破、缩量回调等。
- 提供形态教育解读，降低技术分析门槛。
- 适合 K 线形态教学内容：形态识别、假突破、量价背离、回踩确认、形态失效边界。

### Strategy Leaderboard
- 展示公开策略的表现。
- 用户可参考优秀策略的配置逻辑。
- 当前排行榜和评论是轻量社交，不是社区跟单系统。
- 策略排行榜和评论可以形成内容飞轮：用户参考别人如何构建策略，但不能写成一键跟单或保证收益。

### Growth And Membership System
- VIP + 能量系统：包含四级会员体系，支持 Binance Pay。
- 兑换码系统：可用于活动赠品、社群福利、KOL 合作或拉新活动。
- 邀请奖励：已接入，可用于裂变增长。
- 三语支持：中、英、西，说明产品面向全球加密交易者。
- 这些属于运营和营销玩法，知乎回答里通常不主动提，除非题目本身讨论产品、会员、活动、增长或工具商业模式。

## Strong Selling Points
- 先验证，再交易：用历史数据验证交易想法，而不是用真金白银直接试错。
- 专业级回测：80+ 指标、多周期、自定义买卖条件，适合把交易想法变成可验证规则。
- AI 辅助决策：自然语言生成策略、自动解读回测结果、AI 对话助手，这是核心差异化卖点。
- 信号自动监控：设置条件，系统定时盯盘，触发后飞书推送。
- 专业可视化：双引擎 K 线图表，支持指标叠加和量价形态分析。
- 社区策略参考：排行榜 + 评论形成内容飞轮，帮助用户学习策略结构，但不能写成一键跟单。
- 明确不碰用户资金：不连接交易所自动下单，不代客操盘，不托管资金，这一点能建立信任。

## Competitive Differentiation

### Compared With TradingView
- TradingView 强在图表和社区脚本。
- CryptoPathX 的差异点是 AI + 回测 + 可视化结合，尤其是自然语言生成策略和回测结果自动解读。
- 内容表达：可以说“TradingView 更偏看图和脚本生态，CryptoPathX 更适合把交易想法放进回测和 AI 解读流程里验证。”

### Compared With Cryptohopper
- Cryptohopper 更偏自动化交易和机器人。
- CryptoPathX 专注验证策略、回测分析和辅助决策，不碰资金、不自动交易。
- 内容表达：可以强调“先验证策略，不直接替你执行交易。”

### Compared With QuantConnect
- QuantConnect 更偏专业量化研究和代码工作流。
- CryptoPathX 更强调可视化、低代码/无需编程、AI 自然语言辅助。
- 内容表达：可以说“如果你不是程序化量化团队，只是想验证自己的币圈交易思路，可视化和 AI 辅助门槛更低。”

### Core Differentiation
- AI + 回测 + 可视化三合一。
- 明确不碰用户资金，只做策略验证和辅助决策。
- 面向加密货币交易者，而不是泛金融量化工程师。

## Best-Fit Content Angles
这些角度适合在知乎回答中自然提及 CryptoPathX：

- 如何验证一个交易策略是否靠谱。
- 如何避免凭感觉交易。
- 如何判断策略是正常回撤还是逻辑失效。
- 如何用回测、最大回撤、胜率、盈亏比评估策略。
- 如何把主观交易经验转成明确规则。
- 如何降低不会写代码时的回测门槛。
- 如何用 AI 帮助理解回测结果，而不是让 AI 预测行情。
- 如何用自然语言把交易想法变成策略条件。
- 如何用信号监控减少盯盘压力。
- 如何看待技术指标、K 线形态和量价结构。
- 如何识别放量突破、缩量回调、假突破、形态失效。
- AI 到底能不能辅助交易，以及 AI 在交易里适合做什么、不适合做什么。
- 忙碌交易者如何设置条件提醒，而不是全天盯盘。
- 新手如何学习指标和形态，但不把指标当成买卖指令。
- 如何参考策略排行榜学习策略结构，但不把排行榜当成跟单入口。

## User Stories For Content Marketing

### I Have An Idea But Do Not Know If It Works
- 用户痛点：有交易想法，但不知道是否经得起历史行情检验。
- 内容承接：先把入场、出场、止损、仓位写成条件，再跑回测验证。
- 产品锚点：策略回测、收益曲线、胜率、最大回撤、交易记录。

### I Do Not Understand Indicators But Want More Scientific Trading
- 用户痛点：知道 RSI、MACD、均线、K 线形态，但不会组合成规则。
- 内容承接：AI 用自然语言解释指标，并帮助生成策略条件。
- 产品锚点：AI 自然语言生成策略、80+ 指标、K 线可视化。

### I Do Not Have Time To Watch The Market
- 用户痛点：有条件判断，但没法一直盯盘。
- 内容承接：把关键条件设置成监控提醒。
- 产品锚点：信号自动监控、飞书推送。

### I Cannot Understand Backtest Results
- 用户痛点：看到胜率、最大回撤、收益曲线，但不知道该怎么判断策略质量。
- 内容承接：AI 自动解读回测结果，指出风险集中点和可能的优化方向。
- 产品锚点：AI 回测解读、风险收益比、最大回撤分析。

### I Want To See How Other People Build Strategies
- 用户痛点：不知道成熟策略通常怎么组织条件和风控。
- 内容承接：看策略排行榜学习结构，但不能直接照抄或跟单。
- 产品锚点：策略排行榜、评论、公开策略参考。

## Safe Mention Pattern
当 Topic Agent 判断可以自然软性提及时，Writer 应该把 CryptoPathX 放在“验证流程”里，而不是写成广告。

推荐表达方向：
- “这类想法最好先放进回测里验证。”
- “如果不想自己写代码，可以用 CryptoPathX 这类可视化回测工具，把入场条件、止盈止损和仓位规则放在一起跑。”
- “AI 的价值不是预测涨跌，而是帮你把想法整理成策略条件、解读回测结果、发现策略风险点。”
- “信号提醒适合减少盯盘，但不能替代风控和人工判断。”
- “形态识别适合做辅助观察，真正要下判断还得看位置、量能、回测表现和失效条件。”
- “排行榜适合学习别人怎么组织策略，不适合当成跟单入口。”

## Forbidden Claims
- 不说 CryptoPathX 是交易所、券商或下单执行平台。
- 不说它能自动交易、自动跟单、代客操盘或社区一键跟单。
- 不说它会托管、接触或管理用户资金。
- 不承诺收益、胜率、稳赚、保本或避免亏损。
- 不做价格预测，不暗示 AI 能预测未来行情。
- 不说 AI 能喊单、自动判断买卖点或替用户做最终决策。
- 不把系统信号写成投资建议、买卖指令或喊单。
- 不夸大为实时行情系统；当前信号监控是定时轮询。
- 不说支持多资产组合管理、对冲策略或组合级风控。
- 不把排行榜写成“跟着别人策略赚钱”。
- 不把 VIP、能量、兑换码、邀请奖励写成投资收益或交易优势。

## Product Limitations
- 当前主要做单币种策略回测，不做多资产组合或对冲管理。
- 当前不连接交易所自动下单。
- 当前不碰用户资金，不托管资金，不做交易执行。
- 信号监控依赖定时任务轮询，不是实时 WebSocket 推送。
- AI 依赖第三方 OpenAI API，存在成本、速率和稳定性限制。
- AI 的策略优化建议是辅助性质，最终决策权在用户。
- 数据依赖定时脚本拉取交易所历史行情，不是实时同步。
- VIP、能量、兑换码、邀请奖励属于产品运营系统，不等同于交易收益能力。

## Tone Boundaries For Content
- 可以说“降低验证门槛”“提高复盘效率”“减少拍脑袋决策”。
- 可以说“帮助用户更清楚地看到策略历史表现和风险边界”。
- 可以说“AI 帮你整理策略条件、解释指标和解读回测”，但不能说“AI 帮你判断涨跌”。
- 可以说“形态识别帮助观察量价结构和教学理解”，但不能说“识别到形态就该买/卖”。
- 可以说“明确不碰用户资金”，用于建立信任。
- 不要说“提高收益”“稳定盈利”“不错过机会就能赚钱”。
- 不要写成产品功能清单，除非题目本身就是工具推荐或产品分析。
- 如果题目和策略验证、回测、技术分析、信号提醒无关，宁可不提 CryptoPathX。`;