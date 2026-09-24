/**
 * 检查账号 Profile 的登录状态
 */

import { launchPersistentContext } from "cloakbrowser";
import path from "node:path";

const ACCOUNTS = [
  { id: 1, name: "Default Zhihu Account", zhihuName: "二牛是个老实人" },
  { id: 2, name: "焦花花", zhihuName: "焦花花" }
];

async function checkAccountProfile(account: typeof ACCOUNTS[0]) {
  console.log(`\n=== 检查账号 ${account.id}: ${account.name} (知乎：${account.zhihuName}) ===`);
  
  const profileDir = path.join(process.cwd(), "data", "profiles", `account-${account.id}`, "msedge");
  console.log(`Profile 路径：${profileDir}`);
  
  let browser: any = null;
  try {
    browser = await launchPersistentContext({
      userDataDir: profileDir,
      headless: true,
      viewport: { width: 1280, height: 720 },
    });
    
    const page = browser.pages()[0] ?? (await browser.newPage());
    
    // 访问知乎
    await page.goto("https://www.zhihu.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    
    await page.waitForTimeout(2000);
    
    // 获取 Cookie
    const cookies = await page.context().cookies();
    const zhihuCookies = cookies.filter(c => c.domain.includes("zhihu"));
    
    console.log(`知乎 Cookie 数量：${zhihuCookies.length}`);
    
    // 检查关键 Cookie
    const z_c0 = zhihuCookies.find(c => c.name === "z_c0");
    const captcha = zhihuCookies.find(c => c.name.includes("captcha"));
    const login = zhihuCookies.find(c => c.name.includes("login") || c.name.includes("session"));
    
    console.log(`z_c0 Cookie: ${z_c0 ? "存在" : "不存在"}`);
    console.log(`captcha Cookie: ${captcha ? "存在" : "不存在"}`);
    console.log(`login/session Cookie: ${login ? "存在" : "不存在"}`);
    
    // 检查当前 URL
    console.log(`当前 URL: ${page.url()}`);
    console.log(`页面标题：${await page.title()}`);
    
    // 检查是否已登录
    const isLogin = page.url().includes("/signin") || page.url().includes("/login") ? false : true;
    
    // 尝试查找用户信息
    let detectedUserName: string | null = null;
    try {
      // 尝试从页面找用户名
      const userNameLocator = page.locator(".UserLink-link, .AuthorInfo-name, [class*='user-name'], .topstory-tab-view a[href*='/people/']");
      if (await userNameLocator.count() > 0) {
        detectedUserName = await userNameLocator.first().textContent() || null;
      }
      
      // 如果没有，尝试从设置页找
      if (!detectedUserName) {
        await page.goto("https://www.zhihu.com/settings/account", {
          waitUntil: "domcontentloaded",
          timeout: 10000
        });
        await page.waitForTimeout(1500);
        
        const nameLocator = page.locator("[class*='name'], .AccountSettings-pageTitle");
        if (await nameLocator.count() > 0) {
          detectedUserName = await nameLocator.first().textContent() || null;
        }
      }
    } catch (e) {
      console.log(`获取用户名失败：${e instanceof Error ? e.message : e}`);
    }
    
    console.log(`检测到的用户名：${detectedUserName || "未检测到"}`);
    console.log(`预期用户名：${account.zhihuName}`);
    console.log(`匹配状态：${detectedUserName === account.zhihuName ? "✓ 匹配" : detectedUserName ? `✗ 不匹配 (预期：${account.zhihuName})` : "未知"}`);
    
    await browser.close();
    
    return {
      cookieCount: zhihuCookies.length,
      hasZc0: !!z_c0,
      isLogin,
      detectedUserName,
      matches: detectedUserName === account.zhihuName
    };
  } catch (error) {
    console.log(`检查失败：${error instanceof Error ? error.message : error}`);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return null;
  }
}

async function main() {
  console.log("知乎账号 Profile 登录状态检查");
  console.log("============================\n");
  
  const results = [];
  for (const account of ACCOUNTS) {
    const result = await checkAccountProfile(account);
    results.push({ account, result });
  }
  
  console.log("\n=== 汇总 ===");
  for (const { account, result } of results) {
    if (!result) {
      console.log(`账号 ${account.name}: 检查失败`);
    } else {
      console.log(`账号 ${account.name}:`);
      console.log(`  Cookie 数量：${result.cookieCount}`);
      console.log(`  z_c0: ${result.hasZc0 ? "✓" : "✗"}`);
      console.log(`  登录状态：${result.isLogin ? "✓ 已登录" : "✗ 未登录"}`);
      console.log(`  检测到用户名：${result.detectedUserName || "无"}`);
      console.log(`  匹配状态：${result.matches ? "✓" : "✗"}`);
    }
  }
  
  process.exit(0);
}

main().catch(console.error);
