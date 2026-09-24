// 手动登录 Twitter 脚本
// 用法：npx tsx manual-login.ts

import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';

const ACCOUNT_HANDLE = 'account_a'; // 要登录的账户
const TWITTER_EMAIL = 'info@notionrealistic.xyz';
const TWITTER_PASSWORD = 'notionrealistic';

async function loginToTwitter() {
  console.log('🚀 启动 Twitter 登录流程...\n');

  const profileDir = path.resolve(
    __dirname,
    '../data-x-traditional/profiles',
    ACCOUNT_HANDLE
  );

  console.log(`📁 浏览器配置文件目录：${profileDir}\n`);

  // Use CloakBrowser launchPersistentContext
  const browser = await launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1536, height: 864 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = browser.pages()[0];

  // 启用 Stealth 模式
  await page.addInitScript(() => {
    // @ts-ignore
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  console.log('🌐 打开 Twitter 登录页面...\n');
  await page.goto('https://twitter.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('⏳ 等待登录页面加载...\n');
  
  // 尝试找到登录表单，如果失败则手动等待
  try {
    await page.waitForSelector('input[autocomplete="username"]', {
      timeout: 10000,
    });

  console.log('📧 输入邮箱地址...\n');
  await page.fill('input[autocomplete="username"]', TWITTER_EMAIL);
  await page.press('input[autocomplete="username"]', 'Enter');

  // 等待密码输入框
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  console.log('🔑 输入密码...\n');
  await page.fill('input[type="password"]', TWITTER_PASSWORD);
  await page.press('input[type="password"]', 'Enter');

  console.log('⏳ 等待登录验证...\n');
  await page.waitForTimeout(5000);

  // 检查是否登录成功
  const currentUrl = page.url();
  if (currentUrl.includes('home')) {
    console.log('✅ 登录成功！\n');
    console.log(`📍 当前页面：${currentUrl}\n`);
    console.log('💡 提示：浏览器窗口将保持打开，你可以：\n');
    console.log('   1. 检查是否成功访问 Twitter\n');
    console.log('   2. 手动调整任何验证码或其他验证\n');
    console.log('   3. 关闭浏览器窗口完成登录流程\n');
  } else {
    console.log('⚠️ 可能需要额外验证（如验证码、二次验证等）\n');
    console.log(`📍 当前页面：${currentUrl}\n`);
    console.log('💡 请在浏览器窗口中手动完成验证...\n');
  }

  console.log('⏰ 浏览器将在 60 秒后自动关闭，或手动关闭...\n');

  // 保持浏览器打开 60 秒
  await page.waitForTimeout(60000);

  await browser.closeContext();
  console.log('👋 浏览器已关闭\n');
}

// 处理错误
loginToTwitter().catch(async (error) => {
  console.error('❌ 登录过程出错:', error.message);
  console.log('\n💡 提示：');
  console.log('   - 检查网络连接\n');
  console.log('   - 检查账户密码是否正确\n');
  console.log('   - 如果看到验证码，请在打开的浏览器窗口中手动完成\n');
  process.exit(1);
});
