/**
 * Verify Zhihu login + write-answer entry with CloakBrowser (non-interactive).
 * Usage: npx tsx scripts/verify-cloak-zhihu-login.ts
 */

import { launchPersistentContext } from '../node_modules/cloakbrowser/dist/index.js';
import path from 'node:path';

const CLASH_PROXY = 'http://127.0.0.1:7890';
const TEST_QUESTION_URL =
  process.env.ZHIHU_TEST_QUESTION_URL ?? 'https://www.zhihu.com/question/2022867484454261513';

const PROFILE_DIRS = [
  path.join(process.cwd(), 'data', 'cloak-test-profile'),
];

async function verifyProfile(profileDir: string): Promise<boolean> {
  console.log(`\n━━ Profile: ${profileDir}`);

  const browser = await launchPersistentContext({
    userDataDir: profileDir,
    headless: false,
    proxy: CLASH_PROXY,
    geoip: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  try {
    const page = browser.pages()[0] || (await browser.newPage());
    await page.goto(TEST_QUESTION_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.scrollTo(0, 400)).catch(() => undefined);
    await page.waitForTimeout(1000);

    const url = page.url();
    const title = await page.title();
    console.log(`URL: ${url}`);
    console.log(`Title: ${title || '(empty)'}`);

    if (url.includes('/signin') || url.includes('/account/unhuman')) {
      console.log('❌ Redirected to login or security check');
      return false;
    }

    const cookies = await page.context().cookies();
    const hasLogin = cookies.some((c) => c.name === 'z_c0' && c.domain?.includes('zhihu.com'));
    console.log(`Login cookie z_c0: ${hasLogin ? '✅' : '❌'}`);

    const html = await page.content();
    const hasWriteInDom = html.includes('写回答') || html.includes('WriteAnswer');
    console.log(`Write answer in DOM: ${hasWriteInDom ? '✅' : '❌'}`);

    const existingAnswer = ['查看我的回答', '编辑回答', '我的回答'].filter((t) => html.includes(t));
    if (existingAnswer.length > 0) {
      console.log(`Already answered markers: ${existingAnswer.join(', ')}`);
    }

    const writeByText = page.getByText('写回答', { exact: true });
    const writeCount = await writeByText.count();
    let writeVisible = writeCount > 0 && (await writeByText.first().isVisible().catch(() => false));
    console.log(`Write answer locator count=${writeCount}, visible=${writeVisible}`);

    if (!writeVisible && hasWriteInDom) {
      writeVisible = true;
      console.log('Write answer entry: ✅ (in DOM, forcing check)');
    } else if (!writeVisible) {
      console.log('Write answer entry: ❌ not found');
    } else {
      console.log('Write answer entry: ✅');
    }

    let editorReady = false;
    if (writeVisible) {
      await page.locator("button:has-text('写回答'), a:has-text('写回答')").first().click();
      await page.waitForTimeout(2500);
      const editorSelectors = ["[role='textbox']", ".public-DraftEditor-content", "[contenteditable='true']"];
      for (const sel of editorSelectors) {
        const ed = page.locator(sel).first();
        if ((await ed.count()) > 0 && (await ed.isVisible().catch(() => false))) {
          editorReady = true;
          console.log(`Editor: ✅ (${sel})`);
          break;
        }
      }
      if (!editorReady) {
        console.log('Editor: ❌ not found after click');
      }
    }

    const ok = hasLogin && writeVisible && editorReady;
    console.log(ok ? '\n✅ Profile OK for publish flow' : '\n⚠️ Profile incomplete for publish');
    return ok;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('CloakBrowser Zhihu login verification');
  console.log(`Proxy: ${CLASH_PROXY}`);
  console.log(`Question: ${TEST_QUESTION_URL}`);

  for (const dir of PROFILE_DIRS) {
    try {
      const ok = await verifyProfile(dir);
      if (ok) {
        console.log(`\n🎉 Use profile: ${dir}`);
        process.exit(0);
      }
    } catch (err) {
      console.log(`❌ Error: ${(err as Error).message}`);
    }
  }

  console.log('\n❌ No profile passed full verification');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
