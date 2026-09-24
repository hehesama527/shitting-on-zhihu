import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';
import fs from 'fs/promises';
import { readdirSync } from 'fs';

const TARGET_ACCOUNT = '31-76-72-14-98';
const DATA_DIR = path.join(process.cwd(), 'data');
const ZHIHU_COOKIE_DIR = path.join(DATA_DIR, 'zhihu-cookies');
const ZHIHU_COOKIE_FILE = path.join(ZHIHU_COOKIE_DIR, 'active-cookies.json');
const API_BASE = 'https://www.zhihu.com/api/v4/members';

async function main() {
  console.log('🚀 B 方案：从已登录的浏览器 Profile 提取 Cookie 并测试 API\n');

  // 找到最新的 cookie-fetch profile
  const browserDir = path.join(DATA_DIR, 'zhihu-note-agent', 'browser');
  if (!require('fs').existsSync(browserDir)) {
    console.error('❌ 浏览器目录不存在：', browserDir);
    process.exit(1);
  }

  const profiles = readdirSync(browserDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('cookie-fetch'))
    .sort((a, b) => b.name.localeCompare(a.name)); // 最新的在前

  if (profiles.length === 0) {
    console.error('❌ 没有找到 cookie-fetch 相关的 Profile。请先运行 test-zhihu-api-fetch.ts 进行登录。');
    process.exit(1);
  }

  const latestProfile = profiles[0].name;
  const profilePath = path.join(browserDir, latestProfile);
  
  console.log(`📂 找到最新 Profile: ${latestProfile}`);
  console.log(`📍 路径: ${profilePath}\n`);

  try {
    console.log('🍪 正在从 Profile 提取 Cookie...');
    
    // CloakBrowser launchPersistentContext
    const context = await launchPersistentContext({
      userDataDir: profilePath,
      headless: true,
    });

    const cookies = await context.cookies();
    await context.close();

    // 过滤知乎相关 Cookie
    const relevantCookies = cookies.filter(c => 
      c.domain?.includes('zhihu.com') && 
      ['z_c0', 'd_c0', '_xsrf', 'Hm_lvt', 'Hm_lpvt', 'cap_id'].some(k => c.name.includes(k))
    );

    if (relevantCookies.length === 0) {
      console.error('❌ Profile 中没有找到有效的知乎 Cookie。');
      console.log('   可能登录未完成，或登录的是其他网站。');
      process.exit(1);
    }

    console.log(`✅ 提取到 ${relevantCookies.length} 个知乎 Cookie`);

    // 保存
    await fs.mkdir(ZHIHU_COOKIE_DIR, { recursive: true });
    await fs.writeFile(ZHIHU_COOKIE_FILE, JSON.stringify(relevantCookies, null, 2), 'utf8');
    console.log(`💾 Cookie 已保存至: ${ZHIHU_COOKIE_FILE}\n`);

    // 测试 API
    await testApiWithCookies(relevantCookies);

  } catch (error: any) {
    console.error('❌ 提取失败:', error.message);
    process.exit(1);
  }
}

async function testApiWithCookies(cookies: any[]) {
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
    'Referer': `https://www.zhihu.com/people/${TARGET_ACCOUNT}/answers`,
    'Origin': 'https://www.zhihu.com',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cookie': cookieHeader,
  };

  const apiUrl = `${API_BASE}/${TARGET_ACCOUNT}/answers?include=data[*].content,question.title,created_time,voteup_count&limit=10&offset=0`;

  console.log('📡 正在请求知乎 API...\n');

  try {
    const response = await fetch(apiUrl, { method: 'GET', headers });
    console.log(`🔴 响应状态: ${response.status} ${response.statusText}`);

    if (response.status === 401 || response.status === 403) {
      console.log('❌ Cookie 无效或被风控。');
      return;
    }

    if (!response.ok) {
      console.log('⚠️ 请求失败:', await response.text());
      return;
    }

    const data = await response.json();

    if (data.data?.length > 0) {
      console.log('\n🎉 成功获取数据！\n');
      console.log(`📊 共 ${data.data.length} 条回答\n`);

      data.data.forEach((item: any, i: number) => {
        const text = (item.content || '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .slice(0, 100);
        console.log(`[${i+1}] ${item.question?.title || '无标题'}`);
        console.log(`    赞同: ${item.voteup_count || 0} | ${text}...\n`);
      });

      console.log('✅ B 方案测试通过！方案可行。');
    } else {
      console.log('⚠️ API 返回空数据。');
      console.log('完整响应:', JSON.stringify(data, null, 2).slice(0, 500));
    }

  } catch (error: any) {
    console.error('❌ API 请求异常:', error.message);
  }
}

main();
