import { chromium } from "playwright-core";
import { getAppConfig } from "../packages/core/dist/core/src/index.js";
import { getStealthInitScripts } from "../packages/core/dist/core/src/utils/stealth-inject.js";

console.log("AntiDetection enabled?", getAppConfig().antiDetectionV3Enabled);
const scripts = getStealthInitScripts("/home/userroot/文档/claw/data/profiles/account-6/msedge");
console.log("Got stealth scripts count:", scripts.length);

for (let i = 0; i < scripts.length; i++) {
  try {
    // Try parsing each script as JS Function
    new Function(scripts[i]);
    console.log(`Script ${i}: Valid JS syntax`);
  } catch (err) {
    console.error(`Script ${i}: SYNTAX ERROR!`, err.message);
    console.log("=== SCRIPT CONTENT ===");
    console.log(scripts[i]);
  }
}
