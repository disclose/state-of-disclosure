// Record a no-narration walkthrough of policymaker.disclose.io.
// Captions are injected as overlays so the video is self-explanatory without audio.
// Output: /tmp/pm-demo.webm  (then converted to mp4 by ffmpeg)

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const VIDEO_DIR = '/tmp/pm-video';
mkdirSync(VIDEO_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

const captionStyles = `
  position: fixed; left: 50%; bottom: 36px; transform: translateX(-50%);
  background: linear-gradient(135deg, #4c1d95 0%, #673AB6 100%);
  color: white; padding: 14px 28px; border-radius: 12px;
  font: 600 18px/1.3 -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
  box-shadow: 0 12px 32px rgba(76,29,149,0.35);
  z-index: 999999; max-width: 80%; text-align: center;
  animation: capIn 0.35s ease both;
`;
const keyframes = `@keyframes capIn { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`;

async function caption(text: string, holdMs = 0): Promise<void> {
  await page.evaluate(({ text, css, kf }) => {
    document.querySelectorAll('.demo-caption,.demo-style').forEach(el => el.remove());
    const s = document.createElement('style');
    s.className = 'demo-style';
    s.textContent = kf;
    document.head.appendChild(s);
    const d = document.createElement('div');
    d.className = 'demo-caption';
    d.style.cssText = css;
    d.textContent = text;
    document.body.appendChild(d);
  }, { text, css: captionStyles, kf: keyframes });
  if (holdMs) await page.waitForTimeout(holdMs);
}

async function clearCaption(): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('.demo-caption,.demo-style').forEach(el => el.remove());
  });
}

async function highlight(selector: string, holdMs = 1200): Promise<void> {
  // Use Playwright locator to find (supports :has-text), then mutate via element handle.
  const loc = page.locator(selector).first();
  if (!(await loc.count())) { await page.waitForTimeout(holdMs); return; }
  const handle = await loc.elementHandle();
  if (!handle) { await page.waitForTimeout(holdMs); return; }
  await handle.evaluate(el => {
    (el as HTMLElement).style.transition = 'all 0.25s ease';
    (el as HTMLElement).style.boxShadow = '0 0 0 4px rgba(103,58,182,0.45), 0 12px 32px rgba(103,58,182,0.25)';
    (el as HTMLElement).style.transform = 'scale(1.04)';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(holdMs);
}

async function unhighlight(selector: string): Promise<void> {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return;
  const handle = await loc.elementHandle();
  if (!handle) return;
  await handle.evaluate(el => {
    (el as HTMLElement).style.boxShadow = '';
    (el as HTMLElement).style.transform = '';
  });
}

async function typeSlow(selector: string, text: string, perChar = 80): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded();
  await loc.click();
  await page.waitForTimeout(150);
  await page.keyboard.type(text, { delay: perChar });
}

// ── INTRO TITLE ─────────────────────────────────────────────────
await page.goto('about:blank');
await page.evaluate(() => {
  document.body.style.cssText = 'margin:0;background:linear-gradient(135deg,#4c1d95 0%,#673AB6 100%);height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;color:white;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;';
  document.body.innerHTML = `
    <div style="font-size:14px;letter-spacing:0.2em;opacity:0.8;text-transform:uppercase;margin-bottom:16px;">policymaker.disclose.io</div>
    <div style="font-size:44px;font-weight:700;letter-spacing:-0.02em;text-align:center;line-height:1.1;">From "we have nothing"<br>to a defensible VDP policy</div>
    <div style="font-size:18px;opacity:0.7;margin-top:20px;">in under 60 seconds — no narration, just clicks</div>
  `;
});
await page.waitForTimeout(2800);

// ── STEP 1: Introduction page ──────────────────────────────────
await page.goto('https://policymaker.disclose.io/policymaker/introduction', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await caption('Step 1 of 4 — Read the introduction', 0);
await page.waitForTimeout(1800);
// Highlight the step indicator at the top
await highlight('.dio__step-link.nuxt-link-active', 1200);
await unhighlight('.dio__step-link.nuxt-link-active');
await caption('Hit "Begin" to start', 0);
await highlight('button:has-text("Begin")', 1100);
await page.locator('button:has-text("Begin")').click();
await page.waitForTimeout(1800);

// ── STEP 2: Organization details ───────────────────────────────
await caption('Step 2 — Tell it about your organization', 0);
await page.waitForTimeout(1200);
await highlight('input[placeholder="Organization name"]', 700);
await typeSlow('input[placeholder="Organization name"]', 'Acme Robotics', 70);
await unhighlight('input[placeholder="Organization name"]');
await page.waitForTimeout(400);
await highlight('input[placeholder="Email address or webform url"]', 700);
await typeSlow('input[placeholder="Email address or webform url"]', 'security@acme.example', 60);
await unhighlight('input[placeholder="Email address or webform url"]');
await page.waitForTimeout(800);
await caption('Click Next to advance', 0);
await highlight('button:has-text("Next")', 900);
await page.locator('button:has-text("Next")').click();
await page.waitForTimeout(2200);

// ── STEP 3: Policy settings ────────────────────────────────────
await caption('Step 3 — Pick your policy settings', 0);
await page.waitForTimeout(1200);
// Find any input/select on the settings page and engage with it
const urlInput = page.locator('input[type=url]').first();
if (await urlInput.count()) {
  await highlight('input[type=url]', 700);
  await typeSlow('input[type=url]', 'https://acme.example/security', 50);
  await unhighlight('input[type=url]');
}
await page.waitForTimeout(600);
// Scroll through any radio groups / settings panels
await page.evaluate(() => {
  const main = document.querySelector('main');
  if (main) main.scrollBy({ top: 400, behavior: 'smooth' });
});
await page.waitForTimeout(1600);
await page.evaluate(() => {
  const main = document.querySelector('main');
  if (main) main.scrollBy({ top: 400, behavior: 'smooth' });
});
await page.waitForTimeout(1600);
// Try advancing to download
await caption('Click Next to generate', 0);
const settingsNext = page.locator('button:has-text("Next")').first();
if (await settingsNext.count()) {
  await highlight('main button:has-text("Next")', 800);
  await settingsNext.click();
  await page.waitForTimeout(2200);
}

// ── STEP 4: Download ───────────────────────────────────────────
await caption('Step 4 — Download your policy', 0);
await page.waitForTimeout(1500);
// Look for download buttons / output blocks
await page.evaluate(() => {
  const main = document.querySelector('main');
  if (main) main.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
await page.waitForTimeout(800);
// Highlight any download-related button
const dlBtn = page.locator('button:has-text("Download"), a:has-text("Download")').first();
if (await dlBtn.count()) {
  await highlight('button:has-text("Download"), a:has-text("Download")', 1500);
}
await page.waitForTimeout(800);

// ── OUTRO ──────────────────────────────────────────────────────
await page.goto('about:blank');
await page.evaluate(() => {
  document.body.style.cssText = 'margin:0;background:linear-gradient(135deg,#4c1d95 0%,#673AB6 100%);height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;color:white;font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;';
  document.body.innerHTML = `
    <div style="font-size:14px;letter-spacing:0.2em;opacity:0.8;text-transform:uppercase;margin-bottom:16px;">Build yours</div>
    <div style="font-size:48px;font-weight:700;letter-spacing:-0.02em;line-height:1.1;">policymaker.disclose.io</div>
    <div style="font-size:17px;opacity:0.75;margin-top:24px;max-width:720px;text-align:center;line-height:1.5;">Open-source, legally-reviewed templates for VDP, safe harbor, and CVD timelines — copy-paste ready, in 12 languages.</div>
  `;
});
await page.waitForTimeout(3500);

await page.close();
const videoPath = await page.video()!.path();
await ctx.close();
await browser.close();
console.log('VIDEO:', videoPath);
