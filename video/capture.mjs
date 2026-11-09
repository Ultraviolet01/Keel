// Screens for the demo video, taken from the live app with Playwright (dark theme, 2x).
// Run: node capture.mjs   (writes public/shots/*.png)
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const APP = "https://keel-treasury.vercel.app";
const out = (n) => `public/shots/${n}.png`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await ctx.addInitScript(() => localStorage.setItem("keel-theme", "dark"));
const page = await ctx.newPage();
const wait = (ms) => page.waitForTimeout(ms);

async function company(view, name) {
  await page.goto(`${APP}/app?view=${view}`);
  await wait(6000);
  await page.locator(".company-card").click();
  await page.getByRole("option", { name }).click();
  await wait(6000);
}
async function tab(label, shot) {
  await page.locator(".nav button", { hasText: label }).first().click();
  await wait(2500);
  await page.screenshot({ path: out(shot) });
}

await page.goto(APP);
await wait(4000);
await page.screenshot({ path: out("landing") });

await company("keel-owner.testnet", /compass/i);
await page.screenshot({ path: out("overview") });
await tab("Approvals", "approvals");
await tab("Activity", "activity");
await tab("Payees", "payees");
await tab("Wallets", "wallets");

await company("keelteam85369.sputnikv2.testnet", /deck/i);
await tab("Rules", "multisig");

await browser.close();
console.log("done");
