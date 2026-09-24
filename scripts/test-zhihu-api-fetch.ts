import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import readline from 'readline';

// 目标知乎账号
const TARGET_ACCOUNT = '31-76-72-14-98';

// 数据存储路径
const DATA_DIR = path.join(process.cwd(), 'data');
const ZHIHU_COOKIE_DIR = path.join(DATA_DIR, 'zhihu-cookies');
const ZHIHU_COOKIE_FILE = path.join(ZHIHU_COOKIE_DIR, 'active-cookies.json');

// 知乎 API 端点
const API_BASE = 'https://www.zhihu.com/api/v4/members';

async function runTest() {
  console.log('🚀 开始测试 B 方案：登录获取 Cookie 并调用知乎 API 抓取数据\n');
  
  // 1. 检查是否已经有有效 Cookie
  let cookies: any[] = [];
  if (existsSync(ZHIHU_COOKIE_FILE)) {
    try {
      const content = await fs.readFile(ZHIHU_COOKIE_FILE, 'utf8');
      cookies = JSON.parse(content);
      console.log(`✅ 检测到本地已保存的 Cookie 文件：${ZHIHU_COOKIE_FILE}`);
      
      // 快速验证 Cookie 是否有效
      console.log('🔍 正在验证本地 Cookie 是否有效...\n');
      const isValid = await testApiWithCookies(cookies, 5);
      if (isValid) {
        return; // 验证通过，直接结束
      }
      console.log('⚠️ 本地 Cookie 已失效或权限不足，需要重新登录。\n');
    } catch (e) {
      console.log('⚠️ 读取本地 Cookie 失败，将重新获取。\n');
    }
  }

  // 2. 启动浏览器获取新 Cookie
  console.log('📂 正在准备浏览器环境...\n');
  // 使用带时间戳的独立目录，避免与之前冲突
  const profileDir = path.join(DATA_DIR, 'zhihu-note-agent', 'browser', `cookie-fetch-${Date.now()}`);
  
  // 创建目录
  await fs.mkdir(ZHIHU_COOKIE_DIR, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });

  console.log('🌐 正在启动浏览器进行登录...');
  console.log('💡 提示：请在弹出的浏览器中完成知乎登录，完成后请在下方终端输入 "完成" 并回车。\n');

  const browser = await launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=zh-CN',
    ],
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
  });

  const page = browser.pages()[0] || await browser.newPage();
  
  // 注入防检测
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // 打开知乎首页
  await page.goto('https://www.zhihu.com', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  console.log('✅ 浏览器窗口已弹出！');
  console.log('🔒 请在窗口中完成登录（如需）。');
  console.log('👉 登录完成后，请在下方输入框输入 "完成" 并按回车。\n');

  // 等待用户输入
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  
  const userInput = await new Promise<string>((resolve) => {
    rl.question('🟢 输入 "完成" 并回车继续：', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (userInput.toLowerCase() !== '完成' && userInput.toLowerCase() !== 'done') {
    console.log('\n⚠️ 未确认完成操作，脚本退出。');
    await browser.close();
    process.exit(0);
  }

  console.log('\n🍪 正在从浏览器提取 Cookie...');
  
  try {
    const contextCookies = await browser.context().cookies();
    
    // 过滤知乎相关的核心 Cookie
    const relevantCookies = contextCookies.filter(c => 
      c.domain?.includes('zhihu.com') && 
      ['z_c0', 'd_c0', '_xsrf', 'Hm_lvt', 'Hm_lpvt', 'cap_id'].some(k => c.name.includes(k))
    );

    if (relevantCookies.length === 0) {
      console.error('❌ 未能提取到有效的知乎 Cookie。');
      console.error('可能原因：登录未完成，或者登录的是其他非知乎网站。');
      await browser.close();
      process.exit(1);
    }

    // 保存 Cookie
    await fs.writeFile(ZHIHU_COOKIE_FILE, JSON.stringify(relevantCookies, null, 2), 'utf8');
    console.log(`✅ 成功提取 ${relevantCookies.length} 个 Cookie 并保存至：${ZHIHU_COOKIE_FILE}`);

    // 3. 测试 API 抓取
    console.log('\n📡 正在使用新 Cookie 测试 API 抓取...\n');
    await testApiWithCookies(relevantCookies, 10);

  } catch (error) {
    console.error('❌ 提取 Cookie 失败:', error);
  } finally {
    await browser.close();
  }
}

async function testApiWithCookies(cookies: any[], limit: number) {
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  // 模拟真实请求头（关键：应对风控）
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
    'Referer': `https://www.zhihu.com/people/${TARGET_ACCOUNT}/answers`,
    'Origin': 'https://www.zhihu.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': cookieHeader,
  };

  const apiUrl = `${API_BASE}/${TARGET_ACCOUNT}/answers?include=data[*].content,question.title,created_time,voteup_count&limit=${limit}&offset=0`;

  try {
    console.log(`📡 请求 URL: ${apiUrl}`);
    console.log(`📌 Cookie 长度: ${cookieHeader.length} 字符`);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: headers,
    });

    console.log(`\n🔴 响应状态码: ${response.status} ${response.statusText}`);

    if (response.status === 401 || response.status === 403) {
      console.log('❌ 认证失败。Cookie 无效或已被风控拦截。');
      return false;
    }

    if (!response.ok) {
      console.log(`⚠️ 请求异常: ${await response.text()}`);
      return false;
    }

    const data = await response.json();
    
    if (data.data && Array.isArray(data.data) && data.data.length > 0) {
      console.log('\n🎉 成功获取到数据！\n');
      console.log(`📊 获取到 ${data.data.length} 条回答。\n`);
      
      data.data.forEach((item: any, index: number) => {
        const rawHtml = item.content || '';
        const plainText = rawHtml.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        
        console.log(`📝 回答 ${index + 1}:`);
        console.log(`   问题: ${item.question?.title || '无标题'}`);
        console.log(`   赞同: ${item.voteup_count || 0}`);
        console.log(`   内容预览: ${plainText.slice(0, 120)}...`);
        console.log('');
      });

      console.log('✅ 测试成功！这套方案完全可行。');
      return true;
    } else {
      console.log('⚠️ API 返回了空数据或格式异常。');
      console.log('可能该账号没有公开回答，或者被限制访问。');
      console.log(JSON.stringify(data, null, 2));
      return false;
    }

  } catch (error: any) {
    console.error('❌ API 请求抛出异常:', error.message);
    return false;
  }
}

runTest().catch(err => {
  console.error('💥 脚本运行错误:', err);
  process.exit(1);
});
