import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
import type { UpdateState } from '@/protocol/UpdateState';
import '@/ui/base.css';
import { followSystemTheme } from '@/ui/theme';
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
    <main className="page settings">
      <header className="page-head">
        <h1>Lens settings</h1>
      </header>
      <Updates client={client} />
      <section className="card settings-section" aria-label="VibeQ">
        <div className="section">
          <h2>VibeQ</h2>
          <p className="small muted">Where Lens files reviewed defects. Leave empty if you only export.</p>
        </div>
        <form onSubmit={save}>
          <div className="field">
            <label htmlFor="endpoint" className="label">
              VibeQ address
            </label>
            <input
              id="endpoint"
              className="input"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              placeholder="https://work.sirv.studio"
            />
          </div>
          <div className="field">
            <label htmlFor="token" className="label">
              Personal token
            </label>
            <input
              id="token"
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={settings?.hasToken ? 'Saved; type to replace it' : 'Paste your personal token'}
            />
            <p className="small muted">
              {settings?.tokenFromEnvironment
                ? 'The token comes from LENS_VIBEQ_TOKEN; it overrides the saved one.'
                : settings?.secretStore.state === 'unavailable'
                  ? `The system secret store is unavailable (${settings.secretStore.reason}); Lens cannot save a token.`
                  : 'Lens keeps the token in the system secret store and never shows it again.'}
            </p>
          </div>
          <div className="actions">
            <button type="submit" className="btn btn-primary">
              Save
            </button>
            {settings?.hasToken && !settings.tokenFromEnvironment && (
              <button type="button" className="btn btn-ghost" onClick={(e) => void save(e, true)}>
                Remove token
              </button>
            )}
          </div>
          {message && (
            <div role={message.ok ? 'status' : 'alert'} className="notice" data-tone={message.ok ? 'info' : undefined}>
              {message.text}
            </div>
          )}
        </form>
      </section>
      <section className="card settings-section" aria-label="About">
        <h2>About collection</h2>
        <p className="small muted">
          Lens reads a site only after you allow it from the side panel. While it collects network bodies and console
          messages, Chrome shows a notice that Lens started debugging the browser; that is how the debugger permission
          looks, and it ends when the tab closes. Pause collection any time from the Lens menu in your system tray.
        </p>
      </section>
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
    <section aria-label="Updates" className="card settings-section">
      <h2>Updates</h2>
      <p className="num">
        Lens {state.current}
        {state.available ? ` · ${state.available} is available` : state.checkedAt ? ' · up to date' : ''}
        {state.checkedAt ? ` · checked ${new Date(state.checkedAt).toLocaleString()}` : ''}
      </p>
      {state.managedBy ? (
        <p className="small muted">{state.managedBy} updates this copy of Lens.</p>
      ) : (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={state.automatic}
              onChange={(e) => void act(client.request({ method: 'setAutomaticUpdates', params: { enabled: e.target.checked } }))}
            />
            <span>
              Install updates automatically
              <span className="small muted" style={{ display: 'block' }}>
                Signed releases only. Lens restarts in the background.
              </span>
            </span>
          </label>
          <div className="actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void act(client.request({ method: 'updateNow' }))}
              disabled={busy}
            >
              {busy ? 'Checking…' : 'Check and install now'}
            </button>
          </div>
        </>
      )}
      {(problem || state.lastError) && (
        <div role="alert" className="notice">
          {problem ?? state.lastError}
        </div>
      )}
    </section>
  );
}

followSystemTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
