// 简单的 Twitter 登录测试
import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';

async function testBrowser() {
  const profileDir = path.resolve(
    __dirname,
    '../data-x-traditional/profiles',
    'account_a'
  );

  console.log('🚀 正在启动浏览器...');
  console.log(`📁 配置文件目录：${profileDir}\n`);

  const browser = await launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
    viewport: { width: 1536, height: 864 },
  });

  const page = browser.pages()[0];

  console.log('✅ 浏览器已启动！\n');
  console.log('🌐 正在打开 Twitter (X.com)...\n');

  try {
    await page.goto('https://x.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log(`📍 当前页面：${page.url()}\n`);
  } catch (error) {
    console.log('⚠️ 页面加载超时，但浏览器仍然打开着...\n');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('💡 操作指南：\n');
  console.log('   浏览器窗口已打开，请：\n');
  console.log('   1️⃣  如果看到登录界面，输入账号密码登录\n');
  console.log('   2️⃣  如果遇到验证码，手动完成验证\n');
  console.log('   3️⃣  确认成功登录后，关闭浏览器窗口\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('⏰ 浏览器将保持打开 180 秒（3 分钟）...\n');
  console.log('📝 登录完成后，关闭浏览器窗口即可。\n');

  // 等待 3 分钟，让用户有时间登录
  for (let i = 0; i < 180; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    // 检查浏览器是否还打开着
    try {
      await page.evaluate(() => true);
    } catch {
      console.log('\n👋 检测到浏览器已关闭，退出登录流程。\n');
      return;
    }
  }

  console.log('\n⏰ 时间到，正在关闭浏览器...\n');
  await browser.close();
  console.log('✅ 完成！\n');
}

testBrowser().catch(console.error);
