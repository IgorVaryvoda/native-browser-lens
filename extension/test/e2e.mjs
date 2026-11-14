// End to end: real Chromium + the built extension + `lens register` + the shim + lensd, against a
// local fixture site that fails the way real sites do.
//   LENS_E2E=1 pnpm build && pnpm test:e2e
// LENS_BIN and CHROMIUM_PATH override the binaries.
//
// Linux runs in a temporary home, so no real profile or registration is touched. On macOS and
// Windows, Chromium finds its user folder through the system, not $HOME, so the test registers for
// the current user and unregisters at the end; run it there on CI or a disposable account.
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
const isolated = process.platform === 'linux';

const work = mkdtempSync(join(tmpdir(), 'lens-e2e-'));
const env = {
  ...process.env,
  LENS_HOME: join(work, 'lens'),
  ...(isolated ? { HOME: join(work, 'home'), XDG_CONFIG_HOME: join(work, 'config') } : {}),
};
const profile = isolated ? join(env.XDG_CONFIG_HOME, 'chromium') : join(work, 'profile');
mkdirSync(profile, { recursive: true });
if (process.platform === 'darwin') {
  mkdirSync(join(process.env.HOME, 'Library', 'Application Support', 'Chromium'), { recursive: true });
}
execFileSync(bin, ['register'], { env, stdio: 'inherit' });

// The fixture: a checkout whose price request fails with a body that holds a secret.
const fixture = createServer((request, response) => {
  if (request.url === '/api/price') {
    response.writeHead(500, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ error: 'price is NaN', token: 'fixture-secret-123' }));
  }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end(`<!doctype html><title>Checkout</title><h1>Checkout</h1>
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
  const status = panel.getByRole('status');
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
  await shop.getByRole('button', { name: 'Pay' }).click();
  await shop.waitForResponse(`${site}/api/price`);
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
  if (!evidence.events.some((e) => e.kind === 'response' && e.data.status === 500)) throw new Error('no 500 response');
  console.log(`e2e: ok (${evidence.events.length} events, screenshot ${imageWidth}px wide)`);
} finally {
  await context.close();
  fixture.close();
  execFileSync(bin, ['stop'], { env });
  if (!isolated) execFileSync(bin, ['unregister'], { env });
  rmSync(work, { recursive: true, force: true });
}

/** The one JSON blob in the store: the capture's evidence. */
function findEvidence(blobs) {
  for (const folder of readdirSync(blobs)) {
    for (const name of readdirSync(join(blobs, folder))) {
      const bytes = readFileSync(join(blobs, folder, name));
      if (bytes[0] === 0x7b) return JSON.parse(bytes.toString('utf8'));
    }
  }
  throw new Error('no evidence blob was stored');
}
