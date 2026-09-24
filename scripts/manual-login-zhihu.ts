import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';
import os from 'os';

const TARGET_ZHIHU_ACCOUNT = '31-76-72-14-98';
const ZHIHU_BASE = 'https://www.zhihu.com';

async function manualLoginZhihu() {
  console.log('🚀 正在为知乎 Note Agent 启动手动登录浏览器...\n');
  console.log('目标账号：', TARGET_ZHIHU_ACCOUNT);
  console.log('目的：解决「请登录后查看」和 401 认证错误\n');

  // 使用标准 data 目录
  const dataDir = path.join(process.cwd(), 'data');
  const profileDir = path.join(dataDir, 'zhihu-note-agent', 'browser', `manual-${TARGET_ZHIHU_ACCOUNT}`);

  console.log(`📁 Profile 目录：${profileDir}\n`);

  console.log('💡 操作指南（请在弹出的浏览器中操作）：');
  console.log('1. 如果弹出登录框，请使用你的知乎账号完成登录');
  console.log('2. 登录成功后，确保能看到目标账号的回答列表');
  console.log('3. 可以手动向下滚动页面，模拟正常浏览行为');
  console.log('4. 完成后关闭浏览器窗口即可');
  console.log('5. 登录成功后我们再重新测试 Note Agent 采集\n');

  try {
    const browser = await launchPersistentContext({
      userDataDir: profileDir,
      headless: false,
      viewport: { width: 1440, height: 960 },
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

    // 基础 stealth
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      console.log('%c[Manual Login] Stealth 已注入', 'color: #10b981; font-weight: bold');
    });

    console.log('\n🌐 正在打开知乎目标账号的回答页面...\n');

    await page.goto(`${ZHIHU_BASE}/people/${TARGET_ZHIHU_ACCOUNT}/answers`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    console.log('✅ 浏览器已成功打开并保持运行！');
    console.log('📍 当前页面：', await page.url());
    console.log('\n请在弹出的浏览器窗口中完成登录操作。');
    console.log('登录完成后，请告诉我，我们立即重新测试采集阶段。');

    // 保持打开，不自动关闭
    console.log('\n⏳ 浏览器窗口已就绪，由你手动控制...');

  } catch (error) {
    console.error('❌ 启动失败:', error.message);
    
    // 失败时至少打开首页
    const fallbackBrowser = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'msedge',
    });
    const fallbackPage = fallbackBrowser.pages()[0] || await fallbackBrowser.newPage();
    await fallbackPage.goto(ZHIHU_BASE);
    console.log('已打开知乎首页，请手动导航到目标账号进行登录。');
  }
}

manualLoginZhihu().catch((error) => {
  console.error('💥 严重错误:', error.message);
  process.exit(1);
});
