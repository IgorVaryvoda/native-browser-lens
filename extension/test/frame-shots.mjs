// Puts the marketing-shots.mjs output in browser frames: node test/frame-shots.mjs <out>. The site and
// store images come from frame-*.png (review-file.png cropped to 2880x1500 first).
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const [dir] = process.argv.slice(2);
const f = (n) => pathToFileURL(`${dir}/${n}`).href;
const frame = (url, body) => `<!doctype html><html><head><style>
body{margin:0;padding:32px;background:transparent;font:500 13px Inter,system-ui,sans-serif}
.win{width:max-content;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0/10%)}
.bar{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;background:#eef0f4;border-bottom:1px solid #dde1e8}
.dot{width:12px;height:12px;border-radius:50%}
.url{margin-left:16px;flex:1;max-width:560px;height:26px;display:flex;align-items:center;padding:0 12px;border-radius:7px;background:#fff;color:#4a5263}
.body{display:flex;align-items:stretch}.body img{display:block}
.panel{border-left:1px solid #dde1e8}
</style></head><body><div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span><span class="url">${url}</span></div><div class="body">${body}</div></div></body></html>`;
const shots = [
  ['frame-record.png', 'app.northwind.test/assets', `<img src="${f('site-recording.png')}" width="1040"><img class="panel" src="${f('panel-recording.png')}" width="380">`],
  ['frame-review.png', 'Sirv Lens · Recording', `<img src="${f('editor.png')}" width="1352">`],
  ['frame-file.png', 'Sirv Lens · Review', `<img src="${f('review-file-c.png')}" width="1440">`],
];
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium' });
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 1000 } });
for (const [out, url, body] of shots) {
  writeFileSync(`${dir}/frame.html`, frame(url, body));
  await page.goto(pathToFileURL(`${dir}/frame.html`).href);
  await page.waitForLoadState('networkidle');
  await page.locator('.win').screenshot({ path: `${dir}/${out}`, omitBackground: true });
}
await browser.close();
