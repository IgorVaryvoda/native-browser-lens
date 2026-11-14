// End to end: real Chromium + the built extension + `lens register` + the shim + lensd, against a
// local fixture site that fails the way real sites do.
//   LENS_E2E=1 pnpm build && pnpm test:e2e
// LENS_BIN and CHROMIUM_PATH override the binaries.
//
// macOS and Linux run in a temporary home: Chromium reads user-level hosts from
// <user-data-dir>/NativeMessagingHosts, and the profile is the folder `lens register` writes into.
// Windows reads hosts from HKCU, so there the test registers for the current user and unregisters
// at the end; run it on CI or a disposable account.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const targetDir = () =>
  JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = process.env.LENS_BIN ?? join(targetDir(), 'debug', process.platform === 'win32' ? 'lens.exe' : 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const extensionId = 'cggibhoaigdeemmdlfcncfkmoknndbfd';
const isolated = process.platform !== 'win32';

const work = mkdtempSync(join(tmpdir(), 'lens-e2e-'));
const env = {
  ...process.env,
  LENS_HOME: join(work, 'lens'),
  ...(isolated ? { HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'config') } : {}),
};
const profile = {
  linux: () => join(env.XDG_CONFIG_HOME, 'chromium'),
  darwin: () => join(env.HOME, 'Library', 'Application Support', 'Chromium'),
  win32: () => join(work, 'profile'),
}[process.platform]();
mkdirSync(profile, { recursive: true });
execFileSync(bin, ['register'], { env, stdio: 'inherit' });

// The fixture: a checkout whose price request fails with a body that holds a secret.
const fixture = createServer((request, response) => {
  if (request.url === '/api/price') {
    response.writeHead(500, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ error: 'price is NaN', token: 'fixture-secret-123' }));
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Checkout</title><h1>Checkout</h1>
    <label>Card number <input name="card"></label>
    <button onclick="console.error('total is NaN'); fetch('/api/price')">Pay</button>`);
});
await new Promise((ready) => fixture.listen(0, '127.0.0.1', ready));
const site = `http://127.0.0.1:${fixture.address().port}`;

const systemChromium = '/usr/bin/chromium';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined);
const context = await chromium.launchPersistentContext(profile, {
  // The `chromium` channel is the full browser in new headless mode; the headless shell cannot load extensions.
  ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  headless: true,
  env,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  if (!worker.url().startsWith(`chrome-extension://${extensionId}/`)) {
    throw new Error(`the extension loaded with an unexpected ID: ${worker.url()}`);
  }

  const shop = await context.newPage();
  await shop.goto(`${site}/checkout`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id,
    site,
  );

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  const status = panel.getByRole('status', { name: 'Connection' });
  await status.filter({ hasNotText: 'Connecting' }).waitFor({ timeout: 15_000 });
  const statusText = await status.textContent();
  if (!statusText?.startsWith('Connected')) {
    const log = join(env.LENS_HOME, 'lensd.log');
    throw new Error(`side panel: ${statusText}\nlensd.log: ${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}`);
  }

  // Track the site: a project for its origin, and the debugger attaches to the tab.
  await panel.getByRole('button', { name: 'Collect evidence on this site' }).click();
  await panel.getByText('Collecting network, console and errors').waitFor({ timeout: 15_000 });

  // The defect happens, then the person captures it.
  await shop.getByLabel('Card number').fill('4111111111111111');
  await Promise.all([
    shop.waitForResponse(`${site}/api/price`),
    shop.getByRole('button', { name: 'Pay' }).click(),
  ]);
  await panel.waitForTimeout(500);
  await panel.getByRole('button', { name: 'Capture to a new observation' }).click();

  const observation = panel.getByRole('list', { name: 'Observations' }).getByRole('button', { name: /Checkout/ });
  await observation.or(panel.getByRole('alert')).waitFor({ timeout: 15_000 });
  if (await panel.getByRole('alert').isVisible()) throw new Error(await panel.getByRole('alert').textContent());
  const capture = panel.getByRole('list', { name: 'Captures' }).getByRole('listitem').first();
  await capture.getByText(/\d+ events · \d+ gaps · deep/).waitFor({ timeout: 15_000 });
  await capture.getByRole('img').waitFor();
  const imageWidth = await capture.getByRole('img').evaluate((img) => img.naturalWidth);
  if (!(imageWidth > 0)) throw new Error('the screenshot did not render');

  // The stored evidence holds the defect, and not the secret.
  const evidence = findEvidence(join(env.LENS_HOME, 'blobs'));
  const kinds = new Set(evidence.events.map((e) => e.kind));
  for (const kind of ['console', 'request', 'response', 'responseBody']) {
    if (!kinds.has(kind)) throw new Error(`the evidence has no ${kind} event: ${[...kinds]}`);
  }
  const text = JSON.stringify(evidence);
  if (!text.includes('total is NaN') || !text.includes('price is NaN')) throw new Error('the defect is missing');
  if (text.includes('fixture-secret-123')) throw new Error('the secret reached the notebook');
  const everything = allBlobs(join(env.LENS_HOME, 'blobs'));
  if (everything.includes('4111111111111111')) throw new Error('a typed card number reached the notebook');
  if (!evidence.events.some((e) => e.kind === 'response' && e.data.status === 500)) throw new Error('no 500 response');

  // Annotate: a rectangle, a mask drawn twice with an undo between, then save.
  const [editor] = await Promise.all([
    context.waitForEvent('page'),
    capture.getByRole('button', { name: /Annotate capture/ }).click(),
  ]);
  const canvas = editor.locator('canvas').first();
  await canvas.waitFor({ timeout: 15_000 });
  const area = await canvas.boundingBox();
  const drag = async (x1, y1, x2, y2) => {
    await editor.mouse.move(area.x + x1, area.y + y1);
    await editor.mouse.down();
    await editor.mouse.move(area.x + x2, area.y + y2, { steps: 5 });
    await editor.mouse.up();
  };
  await drag(20, 20, 160, 90);
  await editor.getByRole('button', { name: 'Mask' }).click();
  await drag(200, 20, 300, 60);
  await editor.getByRole('button', { name: 'Undo' }).click();
  await drag(200, 20, 320, 70);
  await editor.getByRole('button', { name: 'Save' }).click();
  await editor.getByRole('status').filter({ hasText: 'Saved · 2 marks' }).waitFor({ timeout: 15_000 });
  await capture.getByText(/· 2 marks/).waitFor({ timeout: 15_000 });

  // Replay: the DOM recording of the seconds before the capture plays in its own page.
  const [replay] = await Promise.all([
    context.waitForEvent('page'),
    capture.getByRole('button', { name: 'Replay' }).click(),
  ]);
  await replay.getByRole('status').filter({ hasText: /s before the capture/ }).waitFor({ timeout: 15_000 });
  const replayed = replay.frameLocator('iframe').first().getByRole('heading', { name: 'Checkout' });
  await replayed.waitFor({ state: 'attached', timeout: 15_000 });

  // Notes: autosave, then still there after the panel reloads (a new shim, the same daemon).
  const notes = 'Coupon SAVE10 applied, then Pay: total shows NaN.';
  await panel.getByLabel('Notes', { exact: true }).fill(notes);
  await panel.getByRole('status', { name: 'Notes status' }).filter({ hasText: /^Saved$/ }).waitFor({ timeout: 15_000 });
  await panel.reload();
  await panel.getByRole('list', { name: 'Observations' }).getByRole('button', { name: /Checkout/ }).click();
  const reloaded = panel.getByLabel('Notes', { exact: true });
  await reloaded.waitFor({ timeout: 15_000 });
  if ((await reloaded.inputValue()) !== notes) throw new Error(`notes after reload: ${await reloaded.inputValue()}`);

  console.log(`e2e: ok (${evidence.events.length} events, screenshot ${imageWidth}px wide, 2 marks, replay, notes kept)`);
} finally {
  // Cleanup must not hide the failure above, and must not hang the job.
  await Promise.race([context.close(), new Promise((done) => setTimeout(done, 20_000))]).catch(() => {});
  fixture.close();
  for (const command of [['stop'], ...(isolated ? [] : [['unregister']])]) {
    try {
      execFileSync(bin, command, { env, timeout: 10_000 });
    } catch (error) {
      console.error(`cleanup: lens ${command[0]}: ${error.message}`);
    }
  }
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (error) {
    console.error(`cleanup: ${error.message}`);
  }
}

function allBlobs(blobs) {
  return readdirSync(blobs)
    .flatMap((folder) => readdirSync(join(blobs, folder)).map((name) => readFileSync(join(blobs, folder, name), 'latin1')))
    .join('\n');
}

/** The one JSON object blob in the store: the capture's evidence. */
function findEvidence(blobs) {
  for (const folder of readdirSync(blobs)) {
    for (const name of readdirSync(join(blobs, folder))) {
      const bytes = readFileSync(join(blobs, folder, name));
      if (bytes[0] === 0x7b) return JSON.parse(bytes.toString('utf8'));
    }
  }
  throw new Error('no evidence blob was stored');
}
