/**
 * 模拟发布流程，检查账号在 writer 阶段的问题
 */

import { launchPersistentContext } from "cloakbrowser";
import path from "node:path";

const ACCOUNTS = [
  { id: 1, name: "Default Zhihu Account", zhihuName: "二牛是个老实人" },
  { id: 2, name: "焦花花", zhihuName: "焦花花" }
];

// 模拟一个测试问题 URL
const TEST_QUESTION_URL = "https://www.zhihu.com/question/265195954";

async function testPublishFlow(account: typeof ACCOUNTS[0]) {
  console.log(`\n=== 测试账号 ${account.id}: ${account.name} (知乎：${account.zhihuName}) ===`);
  
  const profileDir = path.join(process.cwd(), "data", "profiles", `account-${account.id}`, "msedge");
  console.log(`Profile 路径：${profileDir}`);
  
  let browser: any = null;
  try {
    browser = await launchPersistentContext({
      userDataDir: profileDir,
      headless: false,
      viewport: { width: 1280, height: 720 },
    });
    
    const page = browser.pages()[0] ?? (await browser.newPage());
    
    console.log(`\n步骤 1: 访问问题页面`);
    await page.goto(TEST_QUESTION_URL, {
      waitUntil: "domcontentloaded",
      timeout: 15000
    });
    await page.waitForTimeout(2000);
    
    console.log(`  当前 URL: ${page.url()}`);
    console.log(`  页面标题：${await page.title()}`);
    
    // 检查是否是安全验证页
    const isUnhuman = page.url().includes("/account/unhuman");
    const isSignin = page.url().includes("/signin");
    
    if (isUnhuman) {
      console.log(`  ⚠️  检测到安全验证页面！`);
      console.log(`     这是导致 "Connection error." 的根本原因`);
      console.log(`     脚本无法自动通过安全验证`);
    } else if (isSignin) {
      console.log(`  ⚠️  检测到登录页面`);
    } else {
      console.log(`  ✓  正常问题页面`);
    }
    
    // 尝试找"写回答"按钮
    console.log(`\n步骤 2: 查找"写回答"入口`);
    const writeAnswerSelectors = [
      "button:has-text('写回答')",
      "[class*='WriteAnswer']",
      "a:has-text('写回答')",
      "button:has-text('回答')"
    ];
    
    let foundWriteAnswer = false;
    for (const selector of writeAnswerSelectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0) {
          const isVisible = await locator.isVisible();
          console.log(`  找到匹配：${selector} - ${isVisible ? '可见' : '隐藏'}`);
          if (isVisible) {
            foundWriteAnswer = true;
          }
        }
      } catch (e) {
        // 忽略
      }
    }
    
    if (!foundWriteAnswer) {
      console.log(`  ✗  未找到"写回答"按钮`);
      console.log(`     这会导致脚本抛出 "editor_not_ready" 或 "network_or_page_error"`);
    } else {
      console.log(`  ✓  找到"写回答"按钮`);
    }
    
    // 检查页面可见文本
    console.log(`\n步骤 3: 检查页面内容`);
    const visibleTexts = await page.locator("body").allTextContents();
    const combinedText = visibleTexts.join(" ").replace(/\s+/g, " ").trim();
    
    const riskKeywords = ["安全验证", "异常", "验证身份", "滑块", "验证码", "风控"];
    const foundRisks = riskKeywords.filter(kw => combinedText.includes(kw));
    
    if (foundRisks.length > 0) {
      console.log(`  ⚠️  检测到风控关键词：${foundRisks.join(", ")}`);
    }
    
    // 尝试找编辑器
    console.log(`\n步骤 4: 模拟进入编辑状态`);
    if (foundWriteAnswer && !isUnhuman && !isSignin) {
      try {
        const writeButton = page.locator("button:has-text('写回答'), a:has-text('写回答')").first();
        if (await writeButton.isVisible()) {
          await writeButton.click();
          await page.waitForTimeout(2000);
          
          console.log(`  已点击"写回答"`);
          console.log(`  当前 URL: ${page.url()}`);
          
          // 检查编辑器
          const editorSelectors = [
            "[role='textbox']",
            ".public-DraftEditor-content",
            "[contenteditable='true']"
          ];
          
          let editorFound = false;
          for (const selector of editorSelectors) {
            const locator = page.locator(selector).first();
            if (await locator.count() > 0) {
              console.log(`  ✓  找到编辑器：${selector}`);
              editorFound = true;
              break;
            }
          }
          
          if (!editorFound) {
            console.log(`  ✗  未找到编辑器`);
            console.log(`     这会导致 "editor_not_ready" 错误`);
          }
        }
      } catch (e) {
        console.log(`  点击失败：${e instanceof Error ? e.message : e}`);
      }
    } else {
      console.log(`  跳过（因为安全验证或登录状态）`);
    }
    
    console.log(`\n按回车键继续下一个账号测试...`);
    await new Promise(resolve => {
      process.stdin.once("data", resolve);
    });
    
    await browser.close();
    
    return {
      isUnhuman,
      isSignin,
      foundWriteAnswer
    };
  } catch (error) {
    console.log(`测试失败：${error instanceof Error ? error.message : error}`);
    if (browser) {
      await browser.close().catch(() => {});
    }
    return null;
  }
}

async function main() {
  console.log("知乎发布流程 Writer 阶段诊断");
  console.log("===========================\n");
  console.log(`测试问题：${TEST_QUESTION_URL}`);
  
  const results = [];
  for (const account of ACCOUNTS) {
    const result = await testPublishFlow(account);
    results.push({ account, result });
  }
  
  console.log("\n=== 诊断汇总 ===");
  for (const { account, result } of results) {
    console.log(`\n账号 ${account.name}:`);
    if (!result) {
      console.log(`  测试失败`);
    } else if (result.isUnhuman) {
      console.log(`  状态：安全验证页`);
      console.log(`  原因：账号触发知乎风控`);
      console.log(`  表现：脚本无法找到编辑器和发布按钮`);
      console.log(`  错误：Connection error. / unknown_failure`);
      console.log(`  解决：手动登录完成验证`);
    } else if (result.isSignin) {
      console.log(`  状态：登录页`);
      console.log(`  原因：Cookie 失效`);
      console.log(`  解决：手动登录`);
    } else if (result.foundWriteAnswer) {
      console.log(`  状态：正常`);
      console.log(`  发布流程应该可以正常执行`);
    } else {
      console.log(`  状态：异常`);
      console.log(`  未找到写回答入口，可能页面结构变化`);
    }
  }
  
  process.exit(0);
}

main().catch(console.error);
