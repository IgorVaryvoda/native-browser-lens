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

// A VibeQ that commits the first submission and then loses its reply, as a dropped connection does.
const vibeq = { submissions: new Map(), staged: 0, submits: 0, dropFirstReply: true };
const fakeVibeq = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.headers.authorization !== 'Bearer e2e-token') return json(403, { error: 'personal_token_required' });
    const url = request.url;
    if (url === '/auth/me') return json(200, { id: 'member-1' });
    if (url === '/api/members') return json(200, [{ id: 'member-2', name: 'Ana' }]);
    if (url === '/api/attachments/stage') return (vibeq.staged++, json(201, { stagedKey: `staged/member-1/${vibeq.staged}` }));
    const found = url.match(/^\/api\/capture\/v1\/submissions\/(.+)$/);
    if (found) return vibeq.submissions.has(found[1]) ? json(200, vibeq.submissions.get(found[1]).receipt) : json(404, {});
    if (url === '/api/capture/v1/submissions' && request.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      vibeq.submits++;
      const staged = new Set(body.stagedAttachments.map((s) => s.id));
      const missing = body.evidenceManifest.map((a) => a.id).filter((id) => !staged.has(id));
      const receipt = {
        submissionId: body.submissionId, observationId: body.observationId, revision: body.revision,
        taskId: 'task-1', taskUrl: 'http://vibeq.test/?task=task-1', createdAt: 1,
        attachmentStatus: missing.length ? 'partial' : 'complete', missingAttachments: missing,
      };
      vibeq.submissions.set(body.submissionId, { body, receipt });
      if (vibeq.dropFirstReply) return (vibeq.dropFirstReply = false), request.socket.destroy();
      return json(201, receipt);
    }
    json(404, {});
  });
});
await new Promise((ready) => fakeVibeq.listen(0, '127.0.0.1', ready));

const work = mkdtempSync(join(tmpdir(), 'lens-e2e-'));
const env = {
  ...process.env,
  LENS_HOME: join(work, 'lens'),
  LENS_VIBEQ_TOKEN: 'e2e-token',
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
  response.end(`<!doctype html><title>Checkout</title>
    <meta name="csrf-token" content="meta-csrf-555">
    <h1>Checkout</h1>
    <input type="hidden" name="csrf" value="hidden-csrf-777">
    <a href="/next?access_token=link-token-888">Next</a>
    <div contenteditable>draft-secret-999</div>
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
    const read = (name) => (existsSync(join(env.LENS_HOME, name)) ? readFileSync(join(env.LENS_HOME, name), 'utf8') : '(none)');
    throw new Error(`side panel: ${statusText}\nlensd.log: ${read('lensd.log')}\nhost.log: ${read('host.log')}`);
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
  for (const secret of ['4111111111111111', 'meta-csrf-555', 'hidden-csrf-777', 'link-token-888', 'draft-secret-999']) {
    if (everything.includes(secret)) throw new Error(`${secret} reached the notebook`);
  }
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

  // Review and export: only after the person confirms the screenshots; the export holds the
  // daemon-rendered images and a report of what failed.
  const [review] = await Promise.all([
    context.waitForEvent('page'),
    panel.getByRole('button', { name: 'Review and export' }).click(),
  ]);
  const freeze = review.getByRole('button', { name: 'Create review' });
  await freeze.waitFor({ timeout: 15_000 });
  if (await freeze.isEnabled()) throw new Error('a review was possible without the screenshot confirmation');
  await review.getByLabel(/Include the DOM recording/).check();
  await review.getByLabel(/I checked every/).check();
  await freeze.click();
  await review.getByRole('list', { name: 'Reviewed captures' }).getByRole('img').first().waitFor({ timeout: 15_000 });
  await review.getByRole('button', { name: 'Export to Downloads' }).click();
  const exportStatus = review.getByRole('status', { name: 'Export' });
  await exportStatus.waitFor({ timeout: 15_000 });
  await review.getByRole('list', { name: /Findings of capture/ }).getByText(/HTTP 500 from/).waitFor();
  const folder = (await exportStatus.textContent()).replace(/^Exported to /, '');
  const report = readFileSync(join(folder, 'report.md'), 'utf8');
  for (const expected of ['HTTP 500 from', '` Console error: total is NaN `', notes, '![Capture 1](capture-1.png)']) {
    if (!report.includes(expected)) throw new Error(`report.md lacks ${expected}:\n${report}`);
  }
  for (const file of ['capture-1.png', 'capture-1-evidence.json', 'capture-1-recording.json', 'review.json']) {
    if (!existsSync(join(folder, file))) throw new Error(`the export lacks ${file}`);
  }
  if (!isolated) rmSync(folder, { recursive: true, force: true });

  // File to VibeQ: the first reply is lost; filing again finishes without a second task.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.getByLabel('VibeQ address').fill(`http://127.0.0.1:${fakeVibeq.address().port}`);
  await settings.getByRole('button', { name: 'Save' }).click();
  await settings.getByRole('status').filter({ hasText: 'Saved' }).waitFor({ timeout: 15_000 });
  await review.reload();
  await review.getByLabel(/I checked every/).check();
  await review.getByRole('button', { name: 'Create review' }).click();
  await review.getByRole('list', { name: 'Reviewed captures' }).getByRole('img').first().waitFor({ timeout: 15_000 });
  await review.getByLabel('Assign to').selectOption({ label: 'Ana' });
  await review.getByRole('button', { name: 'File to VibeQ' }).click();
  await review.getByRole('alert').filter({ hasText: /Filing again is safe/ }).waitFor({ timeout: 30_000 });
  await review.getByRole('button', { name: 'File to VibeQ' }).click();
  await review.getByRole('status', { name: 'Filing' }).getByRole('link', { name: 'http://vibeq.test/?task=task-1' }).waitFor({ timeout: 30_000 });
  const [submitted] = [...vibeq.submissions.values()];
  if (vibeq.submits !== 1 || vibeq.submissions.size !== 1) throw new Error(`VibeQ got ${vibeq.submits} submits`);
  if (vibeq.staged !== submitted.body.evidenceManifest.length) {
    throw new Error(`${vibeq.staged} uploads for ${submitted.body.evidenceManifest.length} files`);
  }
  if (submitted.body.assigneeId !== 'member-2' || !submitted.body.markdown.includes('HTTP 500 from')) {
    throw new Error(`unexpected submission: ${JSON.stringify(submitted.body).slice(0, 400)}`);
  }

  console.log(`e2e: ok (${evidence.events.length} events, screenshot ${imageWidth}px wide, 2 marks, replay, notes kept, reviewed, exported and filed once despite a lost reply)`);
} finally {
  // Cleanup must not hide the failure above, and must not hang the job.
  await Promise.race([context.close(), new Promise((done) => setTimeout(done, 20_000))]).catch(() => {});
  fixture.close();
  fakeVibeq.close();
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
