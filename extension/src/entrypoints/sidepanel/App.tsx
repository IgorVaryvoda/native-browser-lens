import { useCallback, useEffect, useState } from 'react';
import { LensClient, type LensError } from '@/lens-client';
import { originOf, send, type Broadcast, type CaptureResult, type TabStatus } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Hello } from '@/protocol/Hello';
import type { ObservationSummary } from '@/protocol/ObservationSummary';
import { Notes } from './Notes';

type Connection = { state: 'connecting' } | { state: 'ready'; hello: Hello } | { state: 'failed'; message: string };

const MODE_LABEL = {
  deep: 'Collecting network, console and errors',
  limited: 'Collecting network metadata (this browser has no debugger)',
  screenshotOnly: 'Screenshots only: the browser refused the debugger',
} as const;

/** The tab this panel works on: `?tab=` when given, else the active tab of the panel's window. */
async function targetTab(): Promise<number | null> {
  const pinned = Number(new URLSearchParams(location.search).get('tab'));
  if (pinned) return pinned;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

export function App() {
  const [client, setClient] = useState<LensClient | null>(null);
  const [connection, setConnection] = useState<Connection>({ state: 'connecting' });
  const [observations, setObservations] = useState<ObservationSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [site, setSite] = useState<TabStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refreshSite = useCallback(async () => {
    const id = await targetTab();
    setTabId(id);
    setSite(id === null ? null : await send<TabStatus>({ kind: 'tabStatus', tabId: id }).catch(() => null));
  }, []);

  useEffect(() => {
    const fail = (error: LensError) => setConnection({ state: 'failed', message: error.message });
    const lens = new LensClient(fail);
    setClient(lens);
    Promise.all([lens.request({ method: 'hello' }), lens.request({ method: 'listObservations' })])
      .then(([hello, list]) => {
        setConnection({ state: 'ready', hello });
        setObservations(list);
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
      browser.runtime.onMessage.removeListener(listener);
      lens.disconnect();
    };
  }, [refreshSite]);

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

  return (
    <main>
      <header>
        <h1>Lens</h1>
        <p className="status" data-state={connection.state} role="status" aria-label="Connection">
          {connection.state === 'connecting' && 'Connecting…'}
          {connection.state === 'ready' && `Connected · Lens ${connection.hello.version}`}
          {connection.state === 'failed' && `Not connected: ${connection.message}`}
        </p>
      </header>
      {connection.state === 'ready' && client && (
        <>
          <section aria-label="This site" className="site">
            {site?.origin ? (
              <>
                <p className="origin">{site.origin}</p>
                {site.mode ? (
                  <p className="mode" data-mode={site.mode}>
                    {MODE_LABEL[site.mode]}
                  </p>
                ) : (
                  <button type="button" onClick={track}>
                    Collect evidence on this site
                  </button>
                )}
              </>
            ) : (
              <p className="mode">Lens works on http and https pages.</p>
            )}
            <button type="button" className="primary" onClick={capture} disabled={busy || !site?.origin}>
              {busy ? 'Capturing…' : selected === null ? 'Capture to a new observation' : 'Capture to this observation'}
            </button>
            {problem && <p role="alert">{problem}</p>}
          </section>
          <ul aria-label="Observations">
            {observations.map((o) => (
              <li key={o.id} aria-current={o.id === selected}>
                <button type="button" className="observation" onClick={() => setSelected(o.id === selected ? null : o.id)}>
                  <strong>{o.title}</strong>
                  {o.url && <span className="url">{originOf(o.url) ?? o.url}</span>}
                </button>
                {o.id === selected && (
                  <>
                    <Notes
                      client={client}
                      id={o.id}
                      onSaved={() => void client.request({ method: 'listObservations' }).then(setObservations)}
                    />
                    <Captures client={client} observation={o.id} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function Captures({ client, observation }: { client: LensClient; observation: number }) {
  const [captures, setCaptures] = useState<Capture[]>([]);
  useEffect(() => {
    const load = () => void client.request({ method: 'listCaptures', params: { observation } }).then(setCaptures);
    load();
    const listener = (message: Broadcast) => {
      if ((message.kind === 'captured' || message.kind === 'annotated') && message.capture.observation === observation) load();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [client, observation]);
  if (!captures.length) return <p className="empty">No captures yet.</p>;
  return (
    <ol aria-label="Captures" className="captures">
      {captures.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            className="shot"
            aria-label={`Annotate capture ${c.id}`}
            onClick={() => void browser.tabs.create({ url: browser.runtime.getURL(`/annotate.html?capture=${c.id}`) })}
          >
            <Screenshot client={client} capture={c} />
          </button>
          <span className="facts">
            {c.eventCount} events · {c.gapCount} gaps · {c.mode} · {c.annotations.length} marks
            {c.recording && (
              <>
                {' · '}
                <button
                  type="button"
                  className="link"
                  onClick={() => void browser.tabs.create({ url: browser.runtime.getURL(`/replay.html?capture=${c.id}`) })}
                >
                  Replay
                </button>
              </>
            )}
          </span>
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
  return src ? <img src={src} alt={`Screenshot of ${capture.pageTitle || capture.pageUrl}`} /> : <div className="placeholder" />;
}
