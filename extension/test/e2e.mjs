// End to end: real Chromium + the built extension + `lens register` + the shim + lensd.
// Everything lives in a temporary home, so no real profile, registration or notebook is touched.
//   pnpm build && pnpm test:e2e
// LENS_BIN and CHROMIUM_PATH override the binaries.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const targetDir = () =>
  JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: root })).target_directory;
const bin = process.env.LENS_BIN ?? join(targetDir(), 'debug', process.platform === 'win32' ? 'lens.exe' : 'lens');
const extension = resolve(import.meta.dirname, '../.output/chrome-mv3');
const extensionId = 'cggibhoaigdeemmdlfcncfkmoknndbfd';

const work = mkdtempSync(join(tmpdir(), 'lens-e2e-'));
const env = {
  ...process.env,
  HOME: join(work, 'home'),
  XDG_CONFIG_HOME: join(work, 'config'),
  LENS_HOME: join(work, 'lens'),
};
// The profile is Chromium's own folder under the temporary home, so `lens register` finds it
// exactly as it finds a real browser. Windows registers through HKCU instead (CI runners only).
const profile = {
  linux: join(env.XDG_CONFIG_HOME, 'chromium'),
  darwin: join(env.HOME, 'Library', 'Application Support', 'Chromium'),
  win32: join(work, 'profile'),
}[process.platform];
mkdirSync(profile, { recursive: true });
execFileSync(bin, ['register'], { env, stdio: 'inherit' });

// The system Chromium when there is one, else the browser `playwright-core install chromium` fetched.
// Its `chromium` channel is the full browser in new headless mode; Playwright's default headless
// shell cannot load extensions.
const systemChromium = '/usr/bin/chromium';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(systemChromium) ? systemChromium : undefined);
const context = await chromium.launchPersistentContext(profile, {
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
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 15_000 });

  const title = 'Checkout total shows NaN';
  await page.getByLabel('New observation').fill(title);
  await page.getByRole('button', { name: 'Add' }).click();
  const list = page.getByRole('list', { name: 'Observations' });
  await list.getByText(title).waitFor();

  // A new page is a new shim process: the observation must come back from lensd's store.
  await page.reload();
  await list.getByText(title).waitFor({ timeout: 15_000 });
  console.log('e2e: ok');
} finally {
  await context.close();
  execFileSync(bin, ['stop'], { env });
  rmSync(work, { recursive: true, force: true });
}
