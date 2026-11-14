import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LensClient } from '@/lens-client';
import type { VibeQSettings } from '@/protocol/VibeQSettings';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
