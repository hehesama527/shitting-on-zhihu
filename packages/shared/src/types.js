export const llmReasoningEfforts = ["low", "medium", "high"];
export const llmWireApis = ["responses", "chat_completions"];
export const modelCenterAgentNames = [
    "topic_agent",
    "writer_agent",
    "review_agent",
    "publish_agent",
    "zhihu_note_agent",
    "x_main_agent",
    "x_hotspot_scout_agent",
    "x_research_agent",
    "x_reference_research_agent",
    "x_writer_agent",
    "x_review_agent",
    "x_publish_agent",
    "x_traditional_main_agent",
    "x_traditional_writer_agent",
    "x_traditional_review_agent",
    "x_traditional_publish_agent",
    "x_traditional_note_agent",
    "video_topic_agent",
    "video_writer_agent",
    "video_review_agent",
    "video_visual_planner",
    "video_feedback_agent",
    "ops_agent"
];
export const modelCenterGroupDefinitions = [
    {
        key: "zhihu",
        label: "知乎链路",
        description: "负责选题、写作、审核和发布的知乎生产链路。"
    },
    {
        key: "x",
        label: "X 链路",
        description: "负责研究、写作、审核和发布的 X 独立链路。"
    },
    {
        key: "video",
        label: "Video Hub",
        description: "Platform-neutral video production agents for topics, scripts, visual plans, and feedback."
    },
    {
        key: "system",
        label: "系统协同",
        description: "负责运维诊断与系统级辅助决策。"
    }
];
export const modelCenterAgentDefinitions = [
    {
        name: "topic_agent",
        label: "知乎选题代理",
        shortLabel: "选题",
        group: "zhihu",
        scope: "zhihu",
        description: "负责候选问题筛选、风险识别和选题指纹生成。"
    },
    {
        name: "writer_agent",
        label: "知乎写作代理",
        shortLabel: "写作",
        group: "zhihu",
        scope: "zhihu",
        description: "负责知乎正文草稿生成，并驱动后续润色链路。"
    },
    {
        name: "review_agent",
        label: "知乎审核代理",
        shortLabel: "审核",
        group: "zhihu",
        scope: "zhihu",
        description: "负责硬门禁、编辑质量和发布前审核。"
    },
    {
        name: "publish_agent",
        label: "知乎发布代理",
        shortLabel: "发布",
        group: "zhihu",
        scope: "zhihu",
        description: "负责发布动作规划、回退策略和发布校验。"
    },
    {
        name: "zhihu_note_agent",
        label: "Zhihu Note Agent",
        shortLabel: "Note Agent",
        group: "zhihu",
        scope: "zhihu",
        description: "Produces a manually reviewed Soul candidate for the Zhihu chain."
    },
    {
        name: "x_main_agent",
        label: "X 主控代理",
        shortLabel: "主控",
        group: "x",
        scope: "x",
        description: "负责 X 任务总控、是否研究、是否发帖和发布模式决策。"
    },
    {
        name: "x_hotspot_scout_agent",
        label: "X 热点侦察代理",
        shortLabel: "热点侦察",
        group: "x",
        scope: "x",
        description: "负责热点发现、风险识别和任务建议。"
    },
    {
        name: "x_research_agent",
        label: "X 研究代理",
        shortLabel: "研究",
        group: "x",
        scope: "x",
        description: "负责归纳近期市场信息、提炼研究结论，并为后续写作提供研究上下文。"
    },
    {
        name: "x_reference_research_agent",
        label: "X 参考研究代理",
        shortLabel: "参考研究",
        group: "x",
        scope: "x",
        description: "负责抽取参考账号和外部样本的研究素材，补充 X 链路的参考上下文。"
    },
    {
        name: "x_writer_agent",
        label: "X 写作代理",
        shortLabel: "写作",
        group: "x",
        scope: "x",
        description: "负责 X 帖子草稿、线程结构和表达风格输出。"
    },
    {
        name: "x_review_agent",
        label: "X 审核代理",
        shortLabel: "审核",
        group: "x",
        scope: "x",
        description: "负责 X 内容质量审查、风险拦截和修改建议。"
    },
    {
        name: "x_publish_agent",
        label: "X 发布代理",
        shortLabel: "发布",
        group: "x",
        scope: "x",
        description: "负责 X 发布动作选择、发帖策略和发布校验。"
    },
    {
        name: "x_traditional_main_agent",
        label: "X Traditional Main Agent",
        shortLabel: "Traditional Main",
        group: "x",
        scope: "x",
        description: "Selects topics from hotspots, account Soul, and account goals for the traditional X chain."
    },
    {
        name: "x_traditional_writer_agent",
        label: "X Traditional Writer Agent",
        shortLabel: "Traditional Writer",
        group: "x",
        scope: "x",
        description: "Writes drafts with the traditional X chain's own stable writer prompt."
    },
    {
        name: "x_traditional_review_agent",
        label: "X Traditional Review Agent",
        shortLabel: "Traditional Review",
        group: "x",
        scope: "x",
        description: "Reviews traditional X drafts for Soul fit, topic fit, quality, and risk."
    },
    {
        name: "x_traditional_publish_agent",
        label: "X Traditional Publish Agent",
        shortLabel: "Traditional Publish",
        group: "x",
        scope: "x",
        description: "Reserved publish-planning runtime for the traditional X chain."
    },
    {
        name: "x_traditional_note_agent",
        label: "X Traditional Note Agent",
        shortLabel: "Traditional Note",
        group: "x",
        scope: "x",
        description: "Manually fills and updates account-specific RAG rule documents for the traditional X chain."
    },
    {
        name: "video_topic_agent",
        label: "Video Topic Agent",
        shortLabel: "Video Topic",
        group: "video",
        scope: "video",
        description: "Generates weekly video topic candidates and scores hotspot-topic fit."
    },
    {
        name: "video_writer_agent",
        label: "Video Writer Agent",
        shortLabel: "Video Writer",
        group: "video",
        scope: "video",
        description: "Turns selected topics into horizontal video scripts, segments, subtitles, and image prompts."
    },
    {
        name: "video_review_agent",
        label: "Video Review Agent",
        shortLabel: "Evidence Review",
        group: "video",
        scope: "video",
        description: "Reviews real market-data case evidence and produces verified facts, findings, hypotheses, and safety boundaries."
    },
    {
        name: "video_visual_planner",
        label: "Video Visual Planner",
        shortLabel: "Visual Plan",
        group: "video",
        scope: "video",
        description: "Chooses visual builders such as GPT image, Hyperframe, Remotion cards, or existing assets."
    },
    {
        name: "video_feedback_agent",
        label: "Video Feedback Agent",
        shortLabel: "Feedback",
        group: "video",
        scope: "video",
        description: "Summarizes operator feedback into reusable documents for topic and writing improvement."
    },
    {
        name: "ops_agent",
        label: "运维诊断代理",
        shortLabel: "运维",
        group: "system",
        scope: "ops",
        description: "负责系统故障诊断、根因归纳和处置建议生成。"
    }
];
