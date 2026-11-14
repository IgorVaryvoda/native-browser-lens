import { EvidenceBuffer } from '@/collector/buffer';
import { DeepCollector } from '@/collector/deep';
import { LimitedCollector } from '@/collector/limited';
import { sanitizeUrl } from '@/collector/sanitize';
import { LensClient } from '@/lens-client';
import { clientInfo } from '@/identity';
import { originOf, type BackgroundRequest, type Broadcast, type CaptureResult, type TabStatus } from '@/messages';
import type { Project } from '@/protocol/Project';
import type { JsonValue } from '@/protocol/serde_json/JsonValue';
import type { CoverageGap } from '@/protocol/CoverageGap';

/** The request limit is 16 MiB, shared with the screenshot and the evidence. */
const MAX_RECORDING_BYTES = 8 * 1024 * 1024;

export default defineBackground(() => {
  const buffer = new EvidenceBuffer();
  const urls = new Map<number, string>();
  const deep = DeepCollector.available() ? new DeepCollector(buffer, (tabId) => urls.get(tabId)) : undefined;
  if (!deep) new LimitedCollector(buffer, (tabId) => buffer.mode(tabId) !== undefined).listen();

  let projects: Project[] = [];
  let paused = false;
  let lens: LensClient | null = null;
  const client = () => (lens ??= new LensClient(() => (lens = null)));

  const projectFor = (origin: string | null) =>
    origin ? projects.find((p) => p.enabled && p.origins.includes(origin)) : undefined;
  const permitted = (origin: string | null) =>
    origin ? browser.permissions.contains({ origins: [`${origin}/*`] }) : Promise.resolve(false);

  const queues = new Map<number, Promise<void>>();

  /**
   * Starts or stops collection on a tab to match the projects and the granted origins. Calls for one
   * tab run in order, and each works on the tab's latest URL, so a navigation during an await can
   * never leave the debugger on a site the person did not grant.
   */
  function sync(tabId: number, url: string | undefined): Promise<void> {
    if (url) urls.set(tabId, url);
    const next = (queues.get(tabId) ?? Promise.resolve()).then(() => syncNow(tabId)).catch(() => {});
    queues.set(tabId, next);
    return next;
  }

  async function allowed(tabId: number) {
    const origin = originOf(urls.get(tabId));
    return !paused && Boolean(projectFor(origin)) && (await permitted(origin));
  }

  async function syncNow(tabId: number) {
    if (!(await allowed(tabId))) {
      buffer.stop(tabId);
      await deep?.detach(tabId);
      return;
    }
    if (buffer.mode(tabId) !== undefined && (!deep || deep.isAttached(tabId))) return;
    void injectRecorder(tabId);
    if (!deep) return buffer.start(tabId, 'limited');
    buffer.start(tabId, 'deep');
    try {
      await deep.attach(tabId);
    } catch (error) {
      buffer.start(tabId, 'screenshotOnly');
      buffer.gap(tabId, 'debugger', `The browser refused the debugger: ${(error as Error).message}`);
    }
    if (!(await allowed(tabId))) {
      buffer.stop(tabId);
      await deep.detach(tabId);
    }
  }

  /** The rrweb recorder, in collected tabs only. Idempotent: the script guards against a second run. */
  async function injectRecorder(tabId: number) {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/recorder.js'] });
    } catch (error) {
      buffer.gap(tabId, 'recording', `The page refused the recorder: ${(error as Error).message}`);
    }
  }

  /** The tab's recent DOM recording, or null with a gap that says why. */
  async function takeRecording(tabId: number, gaps: CoverageGap[]) {
    const gap = (reason: string) => gaps.push({ channel: 'recording', reason, startedAt: Date.now(), endedAt: null });
    if (buffer.mode(tabId) === undefined) return null;
    try {
      const events = (await Promise.race([
        browser.tabs.sendMessage(tabId, { kind: 'lens-recording' }),
        new Promise((_, fail) => setTimeout(() => fail(new Error('the recorder did not answer')), 3000)),
      ])) as unknown[] | undefined;
      if (!events?.length) return gap('The recording is empty'), null;
      if (JSON.stringify(events).length > MAX_RECORDING_BYTES) return gap('The recording exceeds 8 MiB'), null;
      return events as JsonValue[];
    } catch (error) {
      return gap((error as Error).message), null;
    }
  }

  async function syncAll() {
    for (const tab of await browser.tabs.query({})) if (tab.id !== undefined) await sync(tab.id, tab.url);
  }

  async function loadProjects() {
    try {
      paused = (await client().request({ method: 'hello' })).paused;
      projects = await client().request({ method: 'listProjects' });
      // Setup's checklist learns from this that the extension is installed, connected and current.
      await client().request({ method: 'announce', params: await clientInfo() });
    } catch {
      projects = [];
    }
    await syncAll();
  }

  async function status(tabId: number): Promise<TabStatus> {
    const tab = await browser.tabs.get(tabId);
    const origin = originOf(tab.url);
    const project = origin ? projects.find((p) => p.origins.includes(origin)) : undefined;
    return {
      origin,
      paused,
      projectId: project?.id ?? null,
      permitted: await permitted(origin),
      mode: buffer.mode(tabId) ?? null,
    };
  }

  async function capture(tabId: number, observation: number | null): Promise<CaptureResult> {
    try {
      const tab = await browser.tabs.get(tabId);
      const screenshot = await takeScreenshot(tab);
      const snapshot = buffer.snapshot(tabId) ?? {
        mode: 'screenshotOnly' as const,
        events: [],
        gaps: [{ channel: 'collector', reason: 'Lens does not collect evidence on this site', startedAt: Date.now(), endedAt: null }],
      };
      const recording = await takeRecording(tabId, snapshot.gaps);
      const page = await pageSnapshot(tabId).catch((error: Error) => {
        snapshot.gaps.push({ channel: 'page', reason: error.message, startedAt: Date.now(), endedAt: null });
        return null;
      });
      const saved = await client().request({
        method: 'createCapture',
        params: {
          observation,
          pageUrl: sanitizeUrl(tab.url ?? ''),
          pageTitle: tab.title ?? '',
          screenshot,
          evidence: { ...snapshot, page },
          recording,
        },
      });
      void broadcast({ kind: 'captured', capture: saved });
      return { ok: true, capture: saved };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  /** Through the debugger when attached; else the visible tab, which needs activeTab (a toolbar
   * click or the shortcut) and the tab in front. */
  async function takeScreenshot(tab: Browser.tabs.Tab): Promise<string> {
    if (tab.id !== undefined && deep?.isAttached(tab.id)) return deep.screenshot(tab.id);
    if (!tab.active && tab.id !== undefined) await browser.tabs.update(tab.id, { active: true });
    const image = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return image.slice(image.indexOf(',') + 1);
  }

  browser.runtime.onMessage.addListener((message: BackgroundRequest, _sender, reply) => {
    const work =
      message.kind === 'capture'
        ? capture(message.tabId, message.observation)
        : message.kind === 'tabStatus'
          ? status(message.tabId)
          : loadProjects();
    work.then(reply, (error: Error) => reply({ ok: false, error: error.message }));
    return true;
  });

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url && buffer.mode(tabId) !== undefined) {
      // Leaving the project's origins stops recording at once; sync then detaches.
      if (projectFor(originOf(change.url))) buffer.record(tabId, 'navigation', { url: change.url });
      else buffer.stop(tabId);
    }
    if (change.url || change.status === 'complete') {
      void sync(tabId, tab.url).then(async () => {
        // A new document has no recorder yet; sync starts one only when collection begins.
        if (change.status === 'complete' && buffer.mode(tabId) !== undefined) await injectRecorder(tabId);
        await broadcast({ kind: 'tabChanged', tabId });
      });
    }
  });
  browser.tabs.onActivated.addListener(({ tabId }) => void broadcast({ kind: 'tabChanged', tabId }));
  browser.tabs.onRemoved.addListener((tabId) => {
    buffer.stop(tabId);
    urls.delete(tabId);
    void deep?.detach(tabId);
  });
  browser.permissions.onAdded.addListener(() => void loadProjects());
  browser.permissions.onRemoved.addListener(() => void loadProjects());

  // The toolbar button opens the notebook beside the page; the shortcut also captures at once.
  if (import.meta.env.FIREFOX) {
    const { sidebarAction } = browser as unknown as { sidebarAction: { toggle(): Promise<void>; open(): Promise<void> } };
    browser.action.onClicked.addListener(() => sidebarAction.toggle());
    browser.commands.onCommand.addListener((command, tab) => {
      if (command !== 'capture' || tab?.id === undefined) return;
      void sidebarAction.open();
      void capture(tab.id, null);
    });
  } else {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    browser.commands.onCommand.addListener((command, tab) => {
      if (command !== 'capture' || tab?.id === undefined) return;
      void browser.sidePanel.open({ tabId: tab.id });
      void capture(tab.id, null);
    });
  }

  void loadProjects();
  // Pause and resume come from the Lens menu, outside the browser: check for them regularly.
  setInterval(() => {
    const before = paused;
    void loadProjects().then(() => {
      if (before !== paused) void broadcast({ kind: 'tabChanged', tabId: -1 });
    });
  }, 15_000);
});

function broadcast(message: Broadcast) {
  return browser.runtime.sendMessage(message).catch(() => {});
}

/** Facts about the page that the screenshot cannot show. Runs in the page's isolated world. */
async function pageSnapshot(tabId: number) {
  const [result] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        scrollX,
        scrollY,
      },
      language: navigator.language,
      userAgent: navigator.userAgent,
      buildId:
        document.querySelector('meta[name="build-sha"],meta[name="git-commit"]')?.getAttribute('content') ?? null,
    }),
  });
  return (result?.result ?? null) as JsonValue | null;
}
