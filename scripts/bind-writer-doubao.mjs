import {
  readModelCenterStoredConfig,
  saveModelCenterConfig
} from "../packages/core/dist/core/src/config/model-center-store.js";

const MODEL_ID = "volcengine-doubao-seed-evolving";
const MODEL_NAME = "doubao-seed-evolving";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const API_KEY = process.env.WRITER_ARK_API_KEY?.trim();

if (!API_KEY) {
  throw new Error("WRITER_ARK_API_KEY is required");
}

const current = readModelCenterStoredConfig();
const models = [
  ...current.models.filter((item) => item.id !== MODEL_ID),
  {
    id: MODEL_ID,
    name: MODEL_NAME,
    providerLabel: "Volcengine Ark Agent Plan",
    notes: "知乎写作 Agent 专用。OpenAI 兼容接口 /api/plan/v3。",
    overrides: {
      model: MODEL_NAME,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      reasoningEffort: "high",
      wireApi: "chat_completions",
      requestTimeoutMs: 600000
    }
  }
];

const agentBindings = current.agentBindings.map((item) => ({
  agentName: item.agentName,
  modelId: item.agentName === "writer_agent" ? MODEL_ID : null
}));

saveModelCenterConfig({
  imageRuntime: current.imageRuntime,
  models,
  agentBindings
});

console.log(
  JSON.stringify(
    {
      writerModel: MODEL_NAME,
      writerBaseUrl: BASE_URL,
      boundAgent: "writer_agent",
      unboundAgents: agentBindings.filter((item) => item.modelId == null).map((item) => item.agentName)
    },
    null,
    2
  )
);
