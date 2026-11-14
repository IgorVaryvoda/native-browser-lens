import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import type { UpdateState } from '@/protocol/UpdateState';
import '../sidepanel/style.css';
import './style.css';

/** VibeQ address and token. The token goes to the OS secret store and is never shown again. */
function Settings() {
  const [client] = useState(() => new LensClient());
  const [settings, setSettings] = useState<VibeQSettings | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [token, setToken] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    client
      .request({ method: 'getVibeQ' })
      .then((found) => {
        setSettings(found);
        setEndpoint(found.endpoint ?? '');
      })
      .catch((error: Error) => setMessage({ ok: false, text: error.message }));
    return () => client.disconnect();
  }, [client]);

  async function save(event: FormEvent, removeToken = false) {
    event.preventDefault();
    try {
      const saved = await client.request({
        method: 'setVibeQ',
        params: { endpoint, token: removeToken ? '' : token.trim() ? token : null },
      });
      setSettings(saved);
      setToken('');
      setMessage({ ok: true, text: 'Saved' });
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    }
  }

  return (
    <main className="settings">
      <h1>Lens settings</h1>
      <Updates client={client} />
      <form onSubmit={save}>
        <h2>VibeQ</h2>
        <label htmlFor="endpoint">VibeQ address</label>
        <input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://work.sirv.studio" />
        <label htmlFor="token">Personal token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={settings?.hasToken ? 'Saved; type to replace it' : 'Paste your personal token'}
        />
        <p className="mode">
          {settings?.tokenFromEnvironment
            ? 'The token comes from LENS_VIBEQ_TOKEN; it overrides the saved one.'
            : settings?.secretStore.state === 'unavailable'
              ? `The system secret store is unavailable (${settings.secretStore.reason}); Lens cannot save a token.`
              : 'Lens keeps the token in the system secret store and never shows it again.'}
        </p>
        <div className="actions">
          <button type="submit" className="primary">
            Save
          </button>
          {settings?.hasToken && !settings.tokenFromEnvironment && (
            <button type="button" onClick={(e) => void save(e, true)}>
              Remove token
            </button>
          )}
        </div>
        {message && <p role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
      </form>
    </main>
  );
}

/** Lens updates itself from signed releases, unless a package manager or the Store does. */
function Updates({ client }: { client: LensClient }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    client.request({ method: 'getUpdates' }).then(setState).catch(() => {});
  }, [client]);
  if (!state) return null;
  const act = async (work: Promise<UpdateState>) => {
    setBusy(true);
    try {
      setState(await work);
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Updates" className="updates">
      <h2>Updates</h2>
      <p>
        Lens {state.current}
        {state.available ? ` · ${state.available} is available` : state.checkedAt ? ' · up to date' : ''}
        {state.checkedAt ? ` · checked ${new Date(state.checkedAt).toLocaleString()}` : ''}
      </p>
      {state.managedBy ? (
        <p className="mode">{state.managedBy} updates this copy of Lens.</p>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              checked={state.automatic}
              onChange={(e) => void act(client.request({ method: 'setAutomaticUpdates', params: { enabled: e.target.checked } }))}
            />{' '}
            Install updates automatically (signed releases only; Lens restarts in the background)
          </label>
          <div className="actions">
            <button type="button" onClick={() => void act(client.request({ method: 'updateNow' }))} disabled={busy}>
              {busy ? 'Checking…' : 'Check and install now'}
            </button>
          </div>
        </>
      )}
      {(problem || state.lastError) && <p role="alert">{problem ?? state.lastError}</p>}
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
