import { resolveLlmRuntimeConfig } from "../packages/core/dist/core/src/config/llm-provider.js";
import { getModelCenterConfigPath } from "../packages/core/dist/core/src/config/model-center-store.js";
import fs from "node:fs";

const agents = ["topic_agent", "writer_agent", "review_agent"];
for (const agent of agents) {
  const resolved = resolveLlmRuntimeConfig(agent);
  console.log(JSON.stringify({
    agent,
    model: resolved.runtime.model,
    baseUrl: resolved.runtime.baseUrl,
    reasoningEffort: resolved.runtime.reasoningEffort,
    wireApi: resolved.runtime.wireApi,
    providerName: resolved.providerName,
    modelSource: resolved.fieldSources.model,
    baseUrlSource: resolved.fieldSources.baseUrl,
    overrideModel: resolved.overrides.model,
    fallbackModel: resolved.fallbackRuntime.model
  }, null, 2));
}

const configPath = getModelCenterConfigPath();
console.log("modelCenterPath", configPath, "exists", fs.existsSync(configPath));
if (fs.existsSync(configPath)) {
  const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const writer = (stored.agentOverrides ?? stored.agents ?? []).find?.((item) => item.agentName === "writer_agent" || item.name === "writer_agent");
  console.log("storedKeys", Object.keys(stored));
  if (Array.isArray(stored.agentOverrides)) {
    console.log("agentOverrides", stored.agentOverrides.map((item) => ({
      agentName: item.agentName,
      model: item.fields?.model ?? item.model ?? null,
      baseUrl: item.fields?.baseUrl ?? item.baseUrl ?? null
    })));
  }
  if (Array.isArray(stored.agentBindings)) {
    console.log("agentBindings", stored.agentBindings);
  }
  if (Array.isArray(stored.models)) {
    console.log("models", stored.models.map((item) => ({
      id: item.id,
      name: item.name,
      providerLabel: item.providerLabel,
      model: item.overrides?.model ?? null,
      baseUrl: item.overrides?.baseUrl ?? null
    })));
  }
}
