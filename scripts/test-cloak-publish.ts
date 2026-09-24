/**
 * CloakBrowser + Clash 代理测试脚本
 * 测试浏览器是否能通过 Clash 代理正常访问知乎
 * 运行方式: npx tsx scripts/test-cloak-publish.ts
 */

// Workaround: cloakbrowser package exports are ESM-only, so we resolve directly
// to avoid tsx resolution issues on Windows
import { launch, launchPersistentContext } from '../node_modules/cloakbrowser/dist/index.js';
import path from 'node:path';

const CLASH_PROXY = 'http://127.0.0.1:7890';
const TEST_QUESTION_URL = 'https://www.zhihu.com/question/265195954';
const PROFILE_DIR = path.join(process.cwd(), 'data', 'cloak-test-profile');

async function testProxy() {
  console.log('🚀 CloakBrowser + Clash 代理测试\n');
  console.log(`代理地址: ${CLASH_PROXY}`);
  console.log(`测试页面: ${TEST_QUESTION_URL}\n`);

  console.log('📌 步骤 1: 测试浏览器是否启动 + 代理是否生效...\n');

  try {
    const browser = await launchPersistentContext({
      userDataDir: PROFILE_DIR,
      headless: false,
      viewport: { width: 1440, height: 900 },
      proxy: CLASH_PROXY,
      geoip: true,
      args: ['--start-maximized', '--no-first-run', '--no-default-browser-check'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    const page = browser.pages()[0] || await browser.newPage();

    console.log('🌐 正在打开知乎问题页面...\n');

    try {
      await page.goto(TEST_QUESTION_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const url = page.url();
      const title = await page.title();

      console.log('✅ 页面加载成功！');
      console.log(`   URL: ${url}`);
      console.log(`   标题: ${title}\n`);

      // 检查是否有登录态
      const cookies = await page.context().cookies();
      const zhihuCookies = cookies.filter(c => c.domain?.includes('zhihu.com'));
      console.log(`🍪 知乎 Cookie 数量: ${zhihuCookies.length}`);
      const hasLogin = zhihuCookies.some(c => c.name === 'z_c0');
      console.log(`   登录 Cookie (z_c0): ${hasLogin ? '✅ 存在' : '❌ 不存在'}\n`);

      // 检查页面内容
      const bodyText = await page.locator('body').textContent().catch(() => '');
      const hasContent = bodyText.includes('回答') || bodyText.includes('问题') || bodyText.includes('写回答');
      console.log(`📄 页面内容: ${hasContent ? '✅ 正常' : '⚠️ 可能未完全加载'}\n`);

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('💡 浏览器已打开，你可以：');
      console.log('   1. 在浏览器里检查是否能正常访问知乎');
      console.log('   2. 尝试点击「写回答」按钮');
      console.log('   3. 手动写一段测试回答并发布');
      console.log('   4. 完成后关闭浏览器窗口即可');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      console.log('⏳ 浏览器保持打开 180 秒，或手动关闭...\n');

      // 等待用户操作
      for (let i = 0; i < 180; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          await page.evaluate(() => true);
        } catch {
          console.log('\n👋 检测到浏览器已关闭');
          return;
        }
      }

      console.log('\n⏰ 时间到，关闭浏览器...');
      await browser.close();

    } catch (navError) {
      console.log('⚠️ 页面导航超时或失败：');
      console.log(`   ${(navError as Error).message}\n`);
      console.log('浏览器仍然打开着，请检查：');
      console.log('   1. Clash 是否正在运行');
      console.log('   2. 代理端口是否为 7890');
      console.log('   3. 知乎域名是否在 Clash 规则中');
      console.log('\n⏳ 浏览器保持打开 60 秒...\n');
      await new Promise(resolve => setTimeout(resolve, 60000));
      await browser.close();
    }

  } catch (error) {
    console.log('❌ 浏览器启动失败：');
    console.log(`   ${(error as Error).message}\n`);
    console.log('请检查：');
    console.log('   1. CloakBrowser 是否已正确安装');
    console.log('   2. Clash 是否正在运行');
    console.log('   3. 代理端口是否正确（7890）');
    process.exit(1);
  }
}

testProxy().catch((error) => {
  console.error('💥 脚本运行错误:', error);
  process.exit(1);
});
