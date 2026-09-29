// 快速 LLM API 测试
async function testLLM() {
  const apiKey = process.env.X_AGENT_API_KEY;
  if (!apiKey) {
    throw new Error("请设置环境变量 X_AGENT_API_KEY");
  }
  const apiUrl = 'https://coding.dashscope.aliyuncs.com/v1/chat/completions';

  console.log('正在测试 LLM API...\n');

  const requestBody = {
    model: 'qwen3.5-plus',
    messages: [
      {
        role: 'user',
        content: '你好，请简单回复一下。',
      },
    ],
    max_tokens: 50,
  };

  const startTime = Date.now();

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('✅ LLM API 调用成功！\n');
    console.log(`响应时间：${elapsed} ms`);
    console.log(`模型：${data.model}`);
    console.log(`回复：${data.choices[0].message.content}\n`);

  } catch (error) {
    console.error('❌ LLM API 调用失败:');
    console.error(error.message);
    process.exit(1);
  }
}

testLLM();
