import { createOpenAiClient, readLlmRuntimeConfig } from "../packages/core/dist/core/src/config/llm-provider.js";

const writer = readLlmRuntimeConfig("writer_agent");
const review = readLlmRuntimeConfig("review_agent");
const topic = readLlmRuntimeConfig("topic_agent");
console.log(
  JSON.stringify(
    {
      writer: { model: writer.model, baseUrl: writer.baseUrl, wireApi: writer.wireApi },
      review: { model: review.model, baseUrl: review.baseUrl },
      topic: { model: topic.model, baseUrl: topic.baseUrl }
    },
    null,
    2
  )
);

const client = createOpenAiClient("writer_agent");
const started = Date.now();
const response = await client.chat.completions.create({
  model: writer.model,
  messages: [{ role: "user", content: "只回复两个字：可用" }],
  stream: false
});
const text = response.choices?.[0]?.message?.content ?? "";
console.log(JSON.stringify({ ok: true, elapsedMs: Date.now() - started, preview: String(text).slice(0, 80) }));
