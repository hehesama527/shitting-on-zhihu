import { launchPersistentContext } from 'cloakbrowser';
import path from 'path';
import fs from 'fs/promises';
import { readdirSync, existsSync } from 'fs';
import { getMysqlPool } from '../packages/core/src/db/mysql.js';
import { applySchemaMigrations } from '../packages/core/src/db/sql.js';
import { ZhihuScrapedContentRepository } from '../packages/core/src/repositories/zhihu-scraped-content-repository.js';

const TARGET_ACCOUNT = '31-76-72-14-98';
const DATA_DIR = path.join(process.cwd(), 'data');
const ZHIHU_COOKIE_DIR = path.join(DATA_DIR, 'zhihu-cookies');
const ZHIHU_COOKIE_FILE = path.join(ZHIHU_COOKIE_DIR, 'active-cookies.json');
const API_BASE = 'https://www.zhihu.com/api/v4/members';

// 每页抓取数量（API 单次 limit）
const PAGE_LIMIT = 20;
// 每个类型的最大抓取条数（设 0 表示不限制，会一直翻页到返回空）
const MAX_PER_TYPE = 100;

async function main() {
  console.log('🚀 知乎内容抓取 - 分页版 + 数据库持久化\n');
  console.log(`目标账号: ${TARGET_ACCOUNT}`);
  console.log(`每页数量: ${PAGE_LIMIT}`);
  console.log(`每种类型上限: ${MAX_PER_TYPE === 0 ? '不限制' : MAX_PER_TYPE + ' 条'}\n`);

  // 1. 获取 Cookie
  let cookies: any[] = [];
  if (existsSync(ZHIHU_COOKIE_FILE)) {
    const content = await fs.readFile(ZHIHU_COOKIE_FILE, 'utf8');
    cookies = JSON.parse(content);
    console.log(`✅ 使用已保存的 Cookie: ${ZHIHU_COOKIE_FILE}\n`);
  }

  if (cookies.length === 0) {
    console.log('⚠️ 没有找到 Cookie，尝试从 Profile 提取...');
    const browserDir = path.join(DATA_DIR, 'zhihu-note-agent', 'browser');
    if (!existsSync(browserDir)) {
      console.error('❌ 浏览器目录不存在。请先登录知乎。');
      process.exit(1);
    }
    const profiles = readdirSync(browserDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('cookie-fetch'))
      .sort((a, b) => b.name.localeCompare(a.name));
    if (profiles.length === 0) {
      console.error('❌ 没有找到 Profile。');
      process.exit(1);
    }
    const context = await launchPersistentContext({
      userDataDir: path.join(browserDir, profiles[0].name),
      headless: true,
    });
    const allCookies = await context.cookies();
    await context.close();
    cookies = allCookies.filter(c =>
      c.domain?.includes('zhihu.com') &&
      ['z_c0', 'd_c0', '_xsrf'].some(k => c.name.includes(k))
    );
    if (cookies.length === 0) {
      console.error('❌ 提取不到有效的知乎 Cookie。');
      process.exit(1);
    }
    await fs.mkdir(ZHIHU_COOKIE_DIR, { recursive: true });
    await fs.writeFile(ZHIHU_COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    console.log(`✅ 提取并保存了 ${cookies.length} 个 Cookie\n`);
  }

  // 2. 连接数据库并应用迁移
  console.log('🗄️  连接数据库...');
  const pool = getMysqlPool();
  await applySchemaMigrations(pool);
  const repo = new ZhihuScrapedContentRepository(pool);
  console.log(`✅ 数据库已就绪\n`);

  // 3. 并发抓取三种类型（分页）
  console.log('📡 开始分页抓取...\n');

  const [answers, articles, pins] = await Promise.all([
    fetchWithPagination(pool, cookies, 'answer', MAX_PER_TYPE),
    fetchWithPagination(pool, cookies, 'article', MAX_PER_TYPE),
    fetchWithPagination(pool, cookies, 'pin', MAX_PER_TYPE),
  ]);

  // 4. 汇总输出
  console.log('\n' + '='.repeat(60));
  console.log('📊 抓取结果');
  console.log('='.repeat(60));
  console.log(`回答: ${answers.length} 条`);
  console.log(`文章: ${articles.length} 条`);
  console.log(`想法: ${pins.length} 条`);
  console.log(`总计: ${answers.length + articles.length + pins.length} 条`);

  // 统计新增数量
  const totalNew = answers.length + articles.length + pins.length;
  console.log(`\n💾 所有数据已写入数据库表 zhihu_scraped_content`);
  console.log(`   使用 ON DUPLICATE KEY UPDATE，重复内容会自动更新而不报错。\n`);

  // 5. 统计数据库中的总量
  const dbTotal = await repo.countByAccount(TARGET_ACCOUNT);
  const dbPending = await repo.countByStatus(TARGET_ACCOUNT, 'pending');
  console.log(`📦 数据库中该账号的总记录: ${dbTotal} 条`);
  console.log(`📦 其中待使用 (pending): ${dbPending} 条`);

  console.log('\n✅ 抓取完成！');
  await pool.end();
}

async function fetchWithPagination(
  pool: any,
  cookies: any[],
  type: 'answer' | 'article' | 'pin',
  maxCount: number
): Promise<any[]> {
  const typeLabel = { answer: '回答', article: '文章', pin: '想法' }[type];
  console.log(`  🔹 抓取 ${typeLabel}...`);

  const allItems: any[] = [];
  let offset = 0;
  let page = 0;

  while (true) {
    page++;
    const items = await fetchPage(cookies, type, PAGE_LIMIT, offset);

    if (items.length === 0) {
      console.log(`     第 ${page} 页返回 0 条，停止翻页。`);
      break;
    }

    allItems.push(...items);
    console.log(`     第 ${page} 页: ${items.length} 条 (累计 ${allItems.length})`);

    offset += PAGE_LIMIT;

    // 达到上限则停止
    if (maxCount > 0 && allItems.length >= maxCount) {
      console.log(`     已达到上限 ${maxCount} 条，停止翻页。`);
      break;
    }
  }

  // 保存到数据库
  if (allItems.length > 0) {
    const repo = new ZhihuScrapedContentRepository(pool);
    const upsertItems = allItems.map(item => buildUpsertInput(TARGET_ACCOUNT, type, item));
    const count = await repo.batchUpsert(upsertItems);
    console.log(`     💾 写入数据库: ${count} 条\n`);
  } else {
    console.log(`     无新数据\n`);
  }

  return allItems;
}

async function fetchPage(cookies: any[], type: string, limit: number, offset: number): Promise<any[]> {
  let url: string;
  if (type === 'answer') {
    url = `${API_BASE}/${TARGET_ACCOUNT}/answers?include=data[*].content,question.title,created_time,voteup_count&limit=${limit}&offset=${offset}`;
  } else if (type === 'article') {
    url = `${API_BASE}/${TARGET_ACCOUNT}/articles?include=data[*].content,title,created_time,voteup_count&limit=${limit}&offset=${offset}`;
  } else {
    url = `${API_BASE}/${TARGET_ACCOUNT}/pins?include=data[*].content,created_time,vote_count&limit=${limit}&offset=${offset}`;
  }

  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
    'Referer': `https://www.zhihu.com/people/${TARGET_ACCOUNT}`,
    'Origin': 'https://www.zhihu.com',
    'Accept': 'application/json, text/plain, */*',
    'Cookie': cookieHeader,
  };

  try {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch {
    return [];
  }
}

function buildUpsertInput(
  account: string,
  type: 'answer' | 'article' | 'pin',
  item: any
) {
  const contentId = String(item.id || '');
  const rawContent = item.content || '';
  let contentText = '';
  let contentHtml = '';

  if (typeof rawContent === 'string') {
    contentHtml = rawContent;
    contentText = rawContent.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
  } else if (typeof rawContent === 'object') {
    contentHtml = JSON.stringify(rawContent);
    contentText = (rawContent.content || rawContent.text || '').replace(/<[^>]+>/g, '').trim();
  }

  return {
    sourceAccount: account,
    contentType: type,
    contentId,
    questionTitle: item.question?.title || item.title || null,
    questionUrl: item.question?.url || item.url || null,
    contentText: contentText || null,
    contentHtml: contentHtml || null,
    voteCount: item.voteup_count ?? item.vote_count ?? 0,
    commentCount: item.comment_count ?? 0,
    createdAt: item.created_time ? new Date(item.created_time * 1000) : null,
  };
}

main().catch(err => {
  console.error('💥 错误:', err);
  process.exit(1);
});
