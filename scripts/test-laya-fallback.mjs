import { LayaService } from "../packages/core/dist/core/src/services/laya-service.js";

async function testFallback() {
  console.log("=================================================================");
  console.log("【测试 Laya 宕机 / 端口关闭时的自动降级容灾】");
  console.log("=================================================================");

  // 指向一个不存在的端口
  const deadLaya = new LayaService("http://127.0.0.1:9999", true);

  const healthy = await deadLaya.isHealthy();
  console.log(`✓ 健康检查（预期 false）: ${healthy}`);

  const res1 = await deadLaya.detectSessionState({
    url: "https://www.zhihu.com",
    title: "知乎",
    visibleTexts: [],
    buttons: []
  });
  console.log(`✓ 登录态判定自动降级（预期 null）: ${res1}`);

  const res2 = await deadLaya.understandPublishPage({
    url: "https://www.zhihu.com",
    title: "知乎",
    buttons: [],
    links: [],
    visibleTexts: []
  });
  console.log(`✓ 动作理解自动降级（预期 null）: ${res2}`);

  const res3 = await deadLaya.reviewPublishResult({
    currentUrl: "https://www.zhihu.com",
    title: "知乎"
  });
  console.log(`✓ 结果核验自动降级（预期 null）: ${res3}`);

  if (res1 === null && res2 === null && res3 === null && !healthy) {
    console.log("\n>>> 容灾测试完美通过：服务不可用时 100% 安全返回 null，平滑进入原有 LLM 逻辑！");
  } else {
    console.error("容灾测试失败");
    process.exit(1);
  }
}

testFallback().catch(console.error);
