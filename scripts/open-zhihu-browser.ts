import { launch, launchPersistentContext } from 'cloakbrowser';
import path from 'path';

const ACCOUNT = '31-76-72-14-98';
const TARGET_URL = `https://www.zhihu.com/people/${ACCOUNT}/answers`;

async function openVisibleBrowser() {
  console.log('🚀 正在启动【可见浏览器】（headless: false）...\n');
  console.log('目标页面：', TARGET_URL);
  console.log('本次使用独立临时 Profile，避免缓存干扰。\n');

  const userDataDir = path.join(process.cwd(), 'data', 'temp-visible-browser');

  console.log('📁 User Data 目录：', userDataDir);
  console.log('🟢 如果浏览器没有弹出，请检查任务栏或告诉我，我会换用 Chrome 强制启动。\n');

  try {
    const browser = await launchPersistentContext({
      userDataDir,
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
    });

    const page = browser.pages()[0] || await browser.newPage();

    // 注入明显提示
    await page.addInitScript(() => {
      console.log('%c【手动测试浏览器】已启动 - 请在窗口中操作', 'color: #10b981; font-size: 16px; font-weight: bold');
      document.title = '【测试用】知乎手动登录 - 可以关闭此窗口';
    });

    console.log('🌐 正在打开知乎页面...\n');

    await page.goto(TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    console.log('✅ 浏览器窗口已成功弹出！');
    console.log('📍 当前地址：', page.url());
    console.log('\n🔴 操作提示：');
    console.log('   • 如果要求登录，请完成登录');
    console.log('   • 登录后请刷新页面，查看是否能看到回答列表');
    console.log('   • 可以手动滚动页面几次');
    console.log('   • 操作完成后请关闭浏览器窗口，然后告诉我“浏览器已关闭”\n');

    // 保持浏览器打开，不自动关闭
    console.log('⏳ 浏览器已保持打开，由你手动控制...');

  } catch (error: any) {
    console.error('❌ 使用 Edge 启动失败:', error.message);
    console.log('\n尝试改用 Chrome 启动...\n');

    // 失败后尝试 Chrome
    try {
      const browser = await launch({
        headless: false,
        args: ['--start-maximized', '--no-first-run']
      });
      const page = await browser.newPage();
      await page.goto(TARGET_URL);
      console.log('✅ 已使用 Chrome 启动浏览器，请查看窗口。');
    } catch (e2: any) {
      console.error('Chrome 也启动失败:', e2.message);
      console.log('\n请检查系统中是否安装了 Edge 或 Chrome，并确保有权限弹出窗口。');
    }
  }
}

openVisibleBrowser().catch(console.error);
