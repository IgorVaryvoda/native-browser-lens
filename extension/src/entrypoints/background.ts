import { ActionLog, EvidenceBuffer, ReplayBuffer, WINDOW_MS } from '@/collector/buffer';
import { DeepCollector } from '@/collector/deep';
import { LimitedCollector } from '@/collector/limited';
import { sanitize, sanitizeUrl } from '@/collector/sanitize';
import { LensClient } from '@/lens-client';
import { clientInfo } from '@/identity';
import { originOf, type BackgroundRequest, type Broadcast, type CaptureResult, type TabStatus } from '@/messages';
import type { Project } from '@/protocol/Project';
import type { JsonValue } from '@/protocol/serde_json/JsonValue';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { Action } from '@/protocol/Action';
import type { PageElement } from '@/protocol/PageElement';
import type { Prepared, RecorderMessage } from './recorder.content';

/** A recording uploads in chunks; past this it is left out with a gap. */
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;

export default defineBackground(() => {
  const buffer = new EvidenceBuffer();
  const actions = new ActionLog();
  const replay = new ReplayBuffer();
  /** Record mode: the tabs with a running session, and when each started. */
  const sessions = new Map<number, number>();
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
      stop(tabId);
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
      stop(tabId);
      await deep.detach(tabId);
    }
  }

  function stop(tabId: number) {
    buffer.stop(tabId);
    actions.clear(tabId);
    replay.clear(tabId);
    sessions.delete(tabId);
  }

  /** The rrweb recorder, in collected tabs only. Idempotent: the script guards against a second run. */
  async function injectRecorder(tabId: number) {
    try {
      await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/recorder.js'] });
    } catch (error) {
      buffer.gap(tabId, 'recording', `The page refused the recorder: ${(error as Error).message}`);
    }
  }

  /**
   * What the page holds for a capture: its recent DOM recording (or null with a gap that says
   * why), the steps it had not reported yet, and the elements on screen.
   */
  async function preparePage(tabId: number, gaps: CoverageGap[]) {
    const gap = (channel: string, reason: string) => gaps.push({ channel, reason, startedAt: Date.now(), endedAt: null });
    const empty = { recording: null, pending: [] as Action[], elements: [] as PageElement[] };
    if (buffer.mode(tabId) === undefined) return empty;
    try {
      const prepared = (await Promise.race([
        browser.tabs.sendMessage(tabId, { kind: 'lens-prepare' }),
        new Promise((_, fail) => setTimeout(() => fail(new Error('the recorder did not answer')), 3000)),
      ])) as Prepared | undefined;
      if (!prepared) return gap('recording', 'The recorder did not answer'), empty;
      replay.add(tabId, prepared.recording);
      return { recording: null, pending: prepared.pending, elements: prepared.elements };
    } catch (error) {
      return gap('recording', (error as Error).message), empty;
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
      session: sessions.get(tabId) ?? null,
      projectId: project?.id ?? null,
      permitted: await permitted(origin),
      mode: buffer.mode(tabId) ?? null,
    };
  }

  /**
   * Saves what the tab recorded from `session` on (Record mode), or the last ten minutes
   * (Capture mode): the replay, the steps, network and console, and a screenshot of now.
   */
  async function capture(tabId: number, observation: number | null, session: number | null = null): Promise<CaptureResult> {
    try {
      const from = session ?? Date.now() - WINDOW_MS;
      const tab = await browser.tabs.get(tabId);
      const screenshot = await takeScreenshot(tab);
      const snapshot = buffer.snapshot(tabId, from) ?? {
        mode: 'screenshotOnly' as const,
        events: [],
        gaps: [{ channel: 'collector', reason: 'Lens does not collect evidence on this site', startedAt: Date.now(), endedAt: null }],
      };
      const { pending, elements } = await preparePage(tabId, snapshot.gaps);
      // The replay lasts until now, also when the page did not change at the end.
      const events = [...replay.slice(tabId, from), { type: 5, data: { tag: 'lens-end', payload: {} }, timestamp: Date.now() }];
      let recording = null;
      if (events.length > 1) {
        const body = new Blob([JSON.stringify(events)], { type: 'application/json' });
        if (body.size > MAX_RECORDING_BYTES) {
          snapshot.gaps.push({ channel: 'recording', reason: 'The recording exceeds 256 MiB', startedAt: Date.now(), endedAt: null });
        } else {
          recording = await client().upload(body, 'application/json');
        }
      }
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
          evidence: { ...snapshot, page, actions: [...actions.snapshot(tabId, from), ...pending], elements },
          recording,
          kind: session === null ? 'moment' : 'session',
          startedAt: session ?? Math.max(from, events[0]?.timestamp ?? from),
        },
      });
      void broadcast({ kind: 'captured', capture: saved });
      return { ok: true, capture: saved };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async function startSession(tabId: number): Promise<{ ok: true; startedAt: number } | { ok: false; error: string }> {
    if (buffer.mode(tabId) === undefined) return { ok: false, error: 'Lens does not collect on this site yet.' };
    const startedAt = sessions.get(tabId) ?? Date.now();
    sessions.set(tabId, startedAt);
    buffer.hold(tabId, startedAt);
    actions.hold(tabId, startedAt);
    replay.hold(tabId, startedAt);
    await browser.tabs.sendMessage(tabId, { kind: 'lens-snapshot' }).catch(() => {});
    void broadcast({ kind: 'tabChanged', tabId });
    return { ok: true, startedAt };
  }

  async function stopSession(tabId: number): Promise<CaptureResult> {
    const startedAt = sessions.get(tabId);
    if (startedAt === undefined) return { ok: false, error: 'No recording runs in this tab.' };
    const result = await capture(tabId, null, startedAt);
    sessions.delete(tabId);
    buffer.hold(tabId, null);
    actions.hold(tabId, null);
    replay.hold(tabId, null);
    void broadcast({ kind: 'tabChanged', tabId });
    return result;
  }

  /** Through the debugger when attached; else the visible tab, which needs activeTab (a toolbar
   * click or the shortcut) and the tab in front. */
  async function takeScreenshot(tab: Browser.tabs.Tab): Promise<string> {
    if (tab.id !== undefined && deep?.isAttached(tab.id)) return deep.screenshot(tab.id);
    if (!tab.active && tab.id !== undefined) await browser.tabs.update(tab.id, { active: true });
    const image = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return image.slice(image.indexOf(',') + 1);
  }

  browser.runtime.onMessage.addListener((message: BackgroundRequest | RecorderMessage, sender, reply) => {
    if (message.kind === 'lens-action' || message.kind === 'lens-replay') {
      const tabId = sender.tab?.id;
      if (tabId === undefined || buffer.mode(tabId) === undefined) return;
      if (message.kind === 'lens-action') actions.add(tabId, message.action);
      else replay.add(tabId, message.events);
      return;
    }
    if (message.kind === 'startSession' || message.kind === 'stopSession') {
      (message.kind === 'startSession' ? startSession(message.tabId) : stopSession(message.tabId)).then(reply, (error: Error) =>
        reply({ ok: false, error: error.message }),
      );
      return true;
    }
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
      if (projectFor(originOf(change.url))) {
        buffer.record(tabId, 'navigation', { url: change.url });
        const url = sanitizeUrl(change.url);
        actions.add(tabId, { timestamp: Date.now(), kind: 'navigate', url, target: null, value: null, masked: false });
      } else stop(tabId);
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
    stop(tabId);
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
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      online: navigator.onLine,
      userAgent: navigator.userAgent,
      // Which build ran: a version meta tag, Next.js's build ID, or a data attribute on <html>.
      buildId: (() => {
        const meta = document.querySelector(
          ['build-sha', 'git-commit', 'git-sha', 'commit', 'commit-sha', 'build-id', 'build', 'version', 'app-version', 'release', 'sentry-release']
            .map((name) => `meta[name="${name}"],meta[property="${name}"]`)
            .join(','),
        );
        const fromMeta = meta?.getAttribute('content');
        if (fromMeta) return fromMeta.slice(0, 120);
        const html = document.documentElement;
        const fromHtml = html.dataset.build ?? html.dataset.version ?? html.dataset.commit;
        if (fromHtml) return fromHtml.slice(0, 120);
        try {
          const next = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent ?? 'null') as { buildId?: string } | null;
          if (next?.buildId) return `next:${next.buildId}`.slice(0, 120);
        } catch {
          // Not a Next.js page.
        }
        // The App Router has no __NEXT_DATA__; its build ID names the manifest's folder.
        const manifest = [...document.scripts].map((x) => x.src).find((src) => /\/_next\/static\/[^/]+\/_(build|ssg)Manifest\.js/.test(src));
        const id = manifest?.match(/\/_next\/static\/([^/]+)\//)?.[1];
        return id ? `next:${id}`.slice(0, 120) : null;
      })(),
      // A site can say what the defect depends on: account role, feature flags, release.
      // <script type="application/json" id="lens-context">{...}</script>
      context: (() => {
        const text = document.querySelector('script#lens-context[type="application/json"]')?.textContent ?? '';
        if (!text || text.length > 8192) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })(),
    }),
  });
  // The context comes from the site: the redaction rules apply to it like to any evidence.
  return sanitize(result?.result ?? null) as JsonValue | null;
}
