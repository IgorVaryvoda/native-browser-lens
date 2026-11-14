import { useCallback, useEffect, useRef, useState } from 'react';
import { LensClient, PROTOCOL_VERSION, type LensError } from '@/lens-client';
import { originOf, send, type Broadcast, type CaptureResult, type TabStatus } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Hello } from '@/protocol/Hello';
import type { ObservationSummary } from '@/protocol/ObservationSummary';
import { AlertIcon, BackIcon, CameraIcon, ExportIcon, PenIcon, PlayIcon, SettingsIcon, LensMark } from '@/ui/icons';
import { Notes } from './Notes';
import { VoiceNotes } from './Voice';
import { InstallApp, SetupCard } from './Onboarding';

type Connection = { state: 'connecting' } | { state: 'ready'; hello: Hello } | { state: 'failed'; message: string };

const MODE = {
  deep: { tone: 'success', label: 'Collecting', detail: 'Collecting network, console and errors' },
  limited: { tone: 'info', label: 'Collecting', detail: 'Network metadata only: this browser has no debugger' },
  screenshotOnly: { tone: 'warning', label: 'Screenshots only', detail: 'The browser refused the debugger' },
} as const;

const SHORTCUT = navigator.userAgent.includes('Mac') ? ['⌥', '⇧', 'L'] : ['Alt', 'Shift', 'L'];

function hostOf(url: string | null | undefined) {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function ago(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** Chromium serves site icons to extensions; Firefox does not, so it gets the host's initial. */
function SiteIcon({ origin }: { origin: string }) {
  const [failed, setFailed] = useState(!browser.runtime.getURL('/').startsWith('chrome-extension://'));
  if (failed) return <span className="site-icon site-initial">{(hostOf(origin) ?? '?')[0]?.toUpperCase()}</span>;
  const src = browser.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(origin)}&size=32` as '/');
  return <img className="site-icon" src={src} alt="" onError={() => setFailed(true)} />;
}

export function App() {
  const [client, setClient] = useState<LensClient | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [observations, setObservations] = useState<ObservationSummary[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [site, setSite] = useState<TabStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastWebTab = useRef<number | null>(null);

  /**
   * The tab this panel works on: `?tab=` when given, else the active tab of the panel's window. A
   * Lens page (review, annotate) is not a site, so the panel keeps the last web tab it targeted.
   */
  const refreshSite = useCallback(async () => {
    const pinned = Number(new URLSearchParams(location.search).get('tab'));
    let id: number | null = pinned || null;
    if (!id) {
      const [active] = await browser.tabs.query({ active: true, currentWindow: true });
      const web = originOf(active?.url) !== null;
      id = web ? (active?.id ?? null) : lastWebTab.current;
      if (id !== null && !web) await browser.tabs.get(id).catch(() => (id = null));
    }
    if (id !== null) lastWebTab.current = id;
    setTabId(id);
    setSite(id === null ? null : await send<TabStatus>({ kind: 'tabStatus', tabId: id }).catch(() => null));
  }, []);

  useEffect(() => {
    // Until the app answers, try again every few seconds: installing it continues this panel.
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const fail = (error: LensError) => {
      if (failed) return;
      failed = true;
      setConnection({ state: 'failed', message: error.message });
      retry = setTimeout(() => setAttempt((n) => n + 1), 3000);
    };
    const lens = new LensClient(fail);
    setClient(lens);
    Promise.all([lens.request({ method: 'hello' }), lens.request({ method: 'listObservations' })])
      .then(([hello, list]) => {
        setConnection({ state: 'ready', hello });
        setObservations(list);
        // The background script connects and announces too, now that the app exists.
        void send({ kind: 'projectsChanged' }).catch(() => {});
      })
      .catch(fail);
    void refreshSite();
    const listener = (message: Broadcast) => {
      if (message.kind === 'tabChanged') void refreshSite();
      if (message.kind === 'captured') {
        void lens.request({ method: 'listObservations' }).then(setObservations);
        setSelected(message.capture.observation);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      clearTimeout(retry);
      browser.runtime.onMessage.removeListener(listener);
      lens.disconnect();
    };
  }, [refreshSite, attempt]);

  const reloadObservations = useCallback(() => {
    void client?.request({ method: 'listObservations' }).then(setObservations);
  }, [client]);

  async function track() {
    if (!client || !site?.origin) return;
    const origin = site.origin;
    // The permission prompt must open inside the click, before any other await.
    const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return setProblem(`Lens may not read ${origin}.`);
    try {
      if (site.projectId === null) {
        await client.request({
          method: 'saveProject',
          params: { id: null, name: new URL(origin).host, origins: [origin], enabled: true },
        });
      }
      await send({ kind: 'projectsChanged' });
      await refreshSite();
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function capture() {
    if (tabId === null) return;
    setBusy(true);
    const result = await send<CaptureResult>({ kind: 'capture', tabId, observation: selected });
    setBusy(false);
    if (!result.ok) return setProblem(`Capture failed: ${result.error}`);
    setProblem(null);
  }

  const current = observations?.find((o) => o.id === selected) ?? null;
  const mode = site?.mode ? MODE[site.mode] : null;

  return (
    <div className="panel">
      <header className="topbar">
        <LensMark />
        <span className="brand">Lens</span>
        <span
          className="conn"
          data-state={connection.state}
          role="status"
          aria-label="Connection"
          title={connection.state === 'failed' ? connection.message : undefined}
        >
          {connection.state === 'connecting' && 'Connecting…'}
          {connection.state === 'ready' && `Connected · Lens ${connection.hello.version}`}
          {connection.state === 'failed' && `Not connected: ${connection.message}`}
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-label="Settings"
          title="Settings"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          <SettingsIcon />
        </button>
      </header>

      {connection.state === 'failed' && <InstallApp reason={connection.message} />}

      {connection.state === 'ready' && client && (
        <>
          {connection.hello.protocol !== PROTOCOL_VERSION && (
            <div role="alert" className="notice" data-tone="warning">
              <AlertIcon />
              <span>
                {connection.hello.protocol < PROTOCOL_VERSION
                  ? 'The Lens app is older than this extension. Run the install line again to update it.'
                  : 'This extension is older than the Lens app. Update the extension.'}
              </span>
            </div>
          )}
          <SetupCard client={client} refresh={site?.mode ? 1 : 0} />

          <section className="card site" aria-label="This site">
            {site?.origin ? (
              <>
                <div className="site-row">
                  <SiteIcon origin={site.origin} />
                  <div className="site-text">
                    <span className="site-host" title={site.origin}>
                      {hostOf(site.origin)}
                    </span>
                    <span className="small muted">
                      {site.paused
                        ? 'Collection is paused from the Lens menu.'
                        : (mode?.detail ?? 'Lens does not collect evidence here yet.')}
                    </span>
                  </div>
                  {site.paused ? (
                    <span className="pill" data-tone="warning">
                      Paused
                    </span>
                  ) : mode ? (
                    <span className="pill" data-tone={mode.tone}>
                      {mode.label}
                    </span>
                  ) : null}
                </div>
                {!site.paused && !site.mode && (
                  <button type="button" className="btn btn-secondary btn-block" onClick={track}>
                    Collect evidence on this site
                  </button>
                )}
              </>
            ) : (
              <p className="small muted">Open a web page (http or https) to capture it.</p>
            )}
            <button
              type="button"
              className="btn btn-primary btn-lg btn-block capture"
              onClick={capture}
              disabled={busy || !site?.origin}
            >
              <CameraIcon size={18} />
              <span>{busy ? 'Capturing…' : current ? `Capture to “${current.title}”` : 'Capture to a new observation'}</span>
              <span className="keys" aria-hidden="true">
                {SHORTCUT.map((k) => (
                  <kbd key={k} className="kbd">
                    {k}
                  </kbd>
                ))}
              </span>
            </button>
            {problem && (
              <div role="alert" className="notice">
                <AlertIcon />
                <span>{problem}</span>
              </div>
            )}
          </section>

          {current ? (
            <Detail
              key={current.id}
              client={client}
              observation={current}
              onBack={() => setSelected(null)}
              onSaved={reloadObservations}
            />
          ) : (
            <Observations list={observations} onOpen={setSelected} />
          )}
        </>
      )}
    </div>
  );
}

function Observations({ list, onOpen }: { list: ObservationSummary[] | null; onOpen: (id: number) => void }) {
  if (list === null) {
    return (
      <div className="list-skeleton" aria-hidden="true">
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    );
  }
  return (
    <section className="observations" aria-label="Your observations">
      <div className="section-head">
        <h2>Observations</h2>
        {list.length > 0 && <span className="small muted num">{list.length}</span>}
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <p>Nothing captured yet.</p>
          <p className="small muted">
            Make the defect happen on the page, then capture it. Lens attaches the last two minutes of network requests,
            console messages and errors, and you can mark up the screenshot afterwards.
          </p>
        </div>
      ) : (
        <ul className="obs-list" aria-label="Observations">
          {list.map((o) => (
            <li key={o.id}>
              <button type="button" className="obs-row" onClick={() => onOpen(o.id)}>
                <span className="obs-title">{o.title}</span>
                <span className="small muted num">
                  {[hostOf(o.url), `${o.captureCount} ${o.captureCount === 1 ? 'capture' : 'captures'}`, ago(o.updatedAt)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Detail({
  client,
  observation,
  onBack,
  onSaved,
}: {
  client: LensClient;
  observation: ObservationSummary;
  onBack: () => void;
  onSaved: () => void;
}) {
  const append = useRef<((text: string) => void) | null>(null);
  return (
    <section className="detail" aria-label="Observation">
      <button type="button" className="btn btn-ghost btn-sm back" onClick={onBack}>
        <BackIcon size={14} />
        All observations
      </button>
      <Notes client={client} id={observation.id} onSaved={onSaved} appendRef={append} />
      <VoiceNotes client={client} observation={observation.id} onAppend={(text) => append.current?.(text)} />
      <Captures client={client} observation={observation.id} />
      <div className="detail-actions">
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() =>
            void browser.tabs.create({ url: browser.runtime.getURL(`/review.html?observation=${observation.id}`) })
          }
        >
          <ExportIcon />
          Review and export
        </button>
      </div>
    </section>
  );
}

function Captures({ client, observation }: { client: LensClient; observation: number }) {
  const [captures, setCaptures] = useState<Capture[] | null>(null);
  useEffect(() => {
    const load = () => void client.request({ method: 'listCaptures', params: { observation } }).then(setCaptures);
    load();
    const listener = (message: Broadcast) => {
      if ((message.kind === 'captured' || message.kind === 'annotated') && message.capture.observation === observation) load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [client, observation]);
  if (captures === null) return <span className="thumb skeleton" aria-hidden="true" />;
  if (!captures.length) return <p className="small muted">No captures yet. Capture adds one here.</p>;
  const open = (path: string) => void browser.tabs.create({ url: browser.runtime.getURL(path as '/') });
  return (
    <ol aria-label="Captures" className="captures">
      {captures.map((c) => (
        <li key={c.id} className="capture-card">
          <button
            type="button"
            className="shot"
            aria-label={`Annotate capture ${c.id}`}
            onClick={() => open(`/annotate.html?capture=${c.id}`)}
          >
            <Screenshot client={client} capture={c} />
          </button>
          <div className="capture-meta">
            <span className="facts small muted num">
              {c.eventCount} events · {c.gapCount} gaps · {c.mode} · {c.annotations.length} marks
            </span>
            <span className="capture-actions">
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label="Annotate"
                title="Annotate"
                onClick={() => open(`/annotate.html?capture=${c.id}`)}
              >
                <PenIcon />
              </button>
              {c.recording && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => open(`/replay.html?capture=${c.id}`)}
                >
                  <PlayIcon />
                  Replay
                </button>
              )}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Screenshot({ client, capture }: { client: LensClient; capture: Capture }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void client.readBlob(capture.screenshot).then((blob) => setSrc((url = URL.createObjectURL(blob))));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, capture.screenshot]);
  return src ? (
    <img className="thumb" src={src} alt={`Screenshot of ${capture.pageTitle || capture.pageUrl}`} />
  ) : (
    <span className="thumb skeleton" />
  );
}
