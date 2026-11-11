/**
 * Demo mode plays with no database, no session and no model: starts the production build with no DATABASE_URL, plays
 * every story from /demo, and fails if a screen calls the API or a story doesn't reach its end.
 * Usage: npm run build && npm run test:demo   (screenshots in .e2e-results/demo-*.png)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { STAGES, STORIES } from "../lib/client/demo-scripts";

const PORT = 3011, ORIGIN = `http://127.0.0.1:${PORT}`;

async function main() {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_DEPLOYMENT: "local", DATABASE_URL: "", ANTHROPIC_API_KEY: "", SPEND_LEDGER_URL: "", VERCEL: "", VERCEL_ENV: "", VERCEL_URL: "" };
  const server = spawn("npx", ["next", "start", "-p", String(PORT), "-H", "127.0.0.1"], { env, stdio: "ignore", detached: true });
  const browser = await chromium.launch();
  try {
    for (let tries = 0; tries < 60; tries++) { if (await fetch(`${ORIGIN}/demo`).then(r => r.ok, () => false)) break; await delay(500); }
    for (const story of STORIES) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const apiCalls: string[] = [], errors: string[] = [];
      page.on("request", request => { const url = new URL(request.url()); if (url.pathname.startsWith("/api/")) apiCalls.push(url.pathname); });
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${ORIGIN}/demo`);
      await page.getByRole("button", { name: new RegExp(`^${story.title}`) }).click();
      const started = Date.now();
      const caption = page.locator("[data-demo-caption]");
      if (story.id === "coordinator") {
        // Space holds the replay after the current step and resumes it.
        await page.keyboard.press("Space");
        await page.locator("[data-demo-paused]").waitFor();
        const held = await caption.innerText();
        await delay(4000);
        assert.equal(await caption.innerText(), held, "the replay moved while paused");
        await page.keyboard.press("Space");
      }
      await caption.filter({ hasText: /That's the demo|The demo stopped/ }).waitFor({ timeout: 300000 });
      await page.screenshot({ path: `.e2e-results/demo-${story.id}.png` });
      assert.match(await caption.innerText(), /That's the demo/, `${story.id} stopped early`);
      assert.deepEqual(apiCalls, [], `${story.id} called the API`);
      assert.deepEqual(errors, [], `${story.id} threw in the page`);
      if (story.id === "full") assert.equal(await page.locator('[data-demo-stage="done"]').count(), STAGES.length, "full story did not reach every stage");
      if (story.id === "full") {
        // Watch again in the same browser: the first viewing must leave nothing behind that changes the second.
        await page.getByRole("button", { name: "Watch again" }).click();
        await caption.filter({ hasText: /That's the demo|The demo stopped/ }).waitFor({ timeout: 400000 });
        assert.match(await caption.innerText(), /That's the demo/, "full story failed on Watch again");
      }
      console.log(`PASS ${story.id}: played to the end in ${Math.round((Date.now() - started) / 1000)} s, zero API calls`);
      await page.close();
    }
  } finally {
    await browser.close();
    if (server.pid) process.kill(-server.pid);
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
