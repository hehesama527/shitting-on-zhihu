/**
 * 知乎连接网络测试脚本
 * 用于诊断 Connection error 问题
 */

import { launch, launchPersistentContext } from "cloakbrowser";
import { existsSync } from "node:fs";
import path from "node:path";

const ZHIHU_URL = "https://www.zhihu.com";
const ZHIHU_API = "https://www.zhihu.com/api/v3";

async function testDirectFetch() {
  console.log("\n=== 测试 1: 直接 Fetch 请求 ===");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(ZHIHU_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    clearTimeout(timeout);
    
    console.log(`✓ 直接请求成功: ${response.status} ${response.statusText}`);
    return true;
  } catch (error) {
    console.log(`✗ 直接请求失败:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function testPlaywrightConnection() {
  console.log("\n=== 测试 2: Playwright 浏览器连接 ===");
  let browser: any = null;
  
  try {
    console.log("启动浏览器...");
    browser = await launch({
      headless: true,
      args: ["--no-sandbox"]
    });
    
    console.log("创建页面...");
    const page = await browser.newPage({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    
    console.log(`访问知乎: ${ZHIHU_URL}`);
    const startTime = Date.now();
    
    const response = await page.goto(ZHIHU_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    
    const loadTime = Date.now() - startTime;
    console.log(`✓ 页面加载成功: ${loadTime}ms`);
    console.log(`  最终 URL: ${page.url()}`);
    console.log(`  页面标题: ${await page.title()}`);
    console.log(`  响应状态: ${response?.status()}`);
    
    // 检查是否有验证码或登录提示
    const hasLoginPrompt = await page.$("#login-button, .SignInButton, [class*='login'], [class*='signin']");
    if (hasLoginPrompt) {
      console.log(` 检测到登录提示`);
    }
    
    const hasCaptcha = await page.$("[class*='captcha'], [id*='captcha'], .captcha");
    if (hasCaptcha) {
      console.log(`⚠ 检测到验证码`);
    }
    
    await browser.close();
    return true;
  } catch (error) {
    console.log(`✗ Playwright 测试失败:`, error instanceof Error ? error.message : error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return false;
  }
}

async function testWithProfile() {
  console.log("\n=== 测试 3: 使用用户 Profile 连接 ===");
  const profileDir = path.join(process.cwd(), "data", "test-profile");
  let browser: any = null;
  
  try {
    console.log(`Profile 目录：${profileDir}`);
    console.log("启动浏览器 (带 profile)...");
    
    browser = await launchPersistentContext({
      userDataDir: profileDir,
      headless: false,
      viewport: null,
    });
    
    const page = browser.pages()[0] ?? (await browser.newPage());
    
    console.log(`访问知乎: ${ZHIHU_URL}`);
    const startTime = Date.now();
    
    const response = await page.goto(ZHIHU_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    
    const loadTime = Date.now() - startTime;
    console.log(`✓ 页面加载成功: ${loadTime}ms`);
    console.log(`  最终 URL: ${page.url()}`);
    console.log(`  页面标题: ${await page.title()}`);
    console.log(`  响应状态: ${response?.status()}`);
    
    // 检查登录状态
    const cookies = await page.context().cookies();
    const zhihuCookies = cookies.filter(c => c.domain.includes("zhihu"));
    console.log(`  知乎 Cookie 数量：${zhihuCookies.length}`);
    
    const hasLogin = zhihuCookies.some(c => c.name.includes("z_c0") || c.name.includes("captcha"));
    console.log(`  登录状态: ${hasLogin ? "✓ 已登录" : "✗ 未登录"}`);
    
    console.log("\n按回车键关闭浏览器...");
    await new Promise(resolve => {
      process.stdin.once("data", resolve);
    });
    
    await browser.close();
    return true;
  } catch (error) {
    console.log(`✗ Profile 测试失败:`, error instanceof Error ? error.message : error);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return false;
  }
}

async function checkNetworkEnvironment() {
  console.log("\n=== 网络环境检查 ===");
  console.log(`HTTP_PROXY: ${process.env.HTTP_PROXY || "未设置"}`);
  console.log(`HTTPS_PROXY: ${process.env.HTTPS_PROXY || "未设置"}`);
  console.log(`NO_PROXY: ${process.env.NO_PROXY || "未设置"}`);
  console.log(`BROWSER_PATH: ${process.env.BROWSER_PATH || "未设置"}`);
  console.log(`CHROME_PATH: ${process.env.CHROME_PATH || "未设置"}`);
  
  // 检查 Edge/Chrome 是否存在
  const edgePaths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  
  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];
  
  console.log("\n浏览器路径检查:");
  for (const p of edgePaths) {
    console.log(`  Edge ${p}: ${existsSync(p) ? "✓" : "✗"}`);
  }
  for (const p of chromePaths) {
    console.log(`  Chrome ${p}: ${existsSync(p) ? "✓" : ""}`);
  }
}

async function main() {
  console.log("知乎网络连接诊断工具");
  console.log("====================");
  
  await checkNetworkEnvironment();
  
  const results = {
    directFetch: await testDirectFetch(),
    playwright: await testPlaywrightConnection()
  };
  
  console.log("\n=== 测试结果汇总 ===");
  console.log(`直接 Fetch: ${results.directFetch ? "✓ 通过" : "✗ 失败"}`);
  console.log(`Playwright: ${results.playwright ? "✓ 通过" : "✗ 失败"}`);
  
  if (!results.directFetch && !results.playwright) {
    console.log("\n⚠️  建议:");
    console.log("1. 检查网络连接是否正常");
    console.log("2. 检查是否需要配置代理");
    console.log("3. 检查防火墙设置");
    console.log("4. 尝试更换网络环境");
  } else if (!results.playwright) {
    console.log("\n⚠️  Playwright 失败但直接请求成功，可能原因:");
    console.log("1. 浏览器未正确安装");
    console.log("2. Playwright 浏览器未安装 (运行: npx playwright install)");
    console.log("3. 浏览器路径配置问题");
  } else {
    console.log("\n✓ 网络连接正常");
  }
  
  console.log("\n是否要测试带用户 Profile 的连接？(需要手动登录验证)");
  console.log("输入 y 继续，其他键跳过...");
  
  const answer = await new Promise<string>(resolve => {
    process.stdin.once("data", data => resolve(data.toString().trim().toLowerCase()));
  });
  
  if (answer === "y" || answer === "yes") {
    await testWithProfile();
  }
  
  process.exit(0);
}

main().catch(console.error);
