import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { SetupStatus } from '@/protocol/SetupStatus';

const RELEASES = 'https://github.com/VKrachun/native-browser-lens/releases/latest/download';

/** The install line for this computer, as the release pages publish it. */
function installCommand(os: string) {
  return os === 'win'
    ? { shell: 'PowerShell', command: `irm ${RELEASES}/install.ps1 | iex` }
    : { shell: os === 'mac' ? 'Terminal' : 'a terminal', command: `curl -fsSL ${RELEASES}/install.sh | sh` };
}

/**
 * Shown while the extension cannot reach the Lens app. `reason` is the browser's message:
 * "host not found" means the app is not installed; anything else means it is installed but failed.
 */
export function InstallApp({ reason }: { reason: string }) {
  const [os, setOs] = useState('linux');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void browser.runtime.getPlatformInfo().then((info) => setOs(info.os));
  }, []);
  const missing = /not found/i.test(reason);
  const { shell, command } = installCommand(os);
  return (
    <section className="onboarding" aria-label="Install the Lens app">
      {missing ? (
        <>
          <h2>One more step: the Lens app</h2>
          <p>
            The extension collects evidence; the Lens app on this computer keeps your notebook, its screenshots and
            your VibeQ filings. Open {shell}, paste this line and press Enter:
          </p>
        </>
      ) : (
        <>
          <h2>Lens did not start</h2>
          <p>
            The app is installed but stopped with: <em>{reason}</em>. Running this line again repairs it; <code>lens doctor</code>{' '}
            shows what is wrong.
          </p>
        </>
      )}
      <pre className="command">{command}</pre>
      <button
        type="button"
        className="primary"
        onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
      >
        {copied ? 'Copied' : 'Copy the line'}
      </button>
      <p className="mode" role="status" aria-label="Waiting for the app">
        Waiting for the Lens app… this panel continues by itself.
      </p>
    </section>
  );
}

/** The setup checklist from the app, until every required step is done. */
export function SetupCard({ client, refresh }: { client: LensClient; refresh: number }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .request({ method: 'setupStatus' })
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, refresh]);
  if (!status) return null;
  const open = status.steps.filter((s) => s.mark === 'todo');
  if (open.length === 0) return null;
  const done = status.steps.filter((s) => s.mark === 'done').length;
  return (
    <section className="setup" aria-label="Setup">
      <h2>
        Setup: {done} of {status.steps.filter((s) => s.mark !== 'optional').length} done
      </h2>
      <ul>
        {status.steps.map((step) => (
          <li key={step.name} data-mark={step.mark}>
            <span aria-hidden="true">{step.mark === 'done' ? '✓' : step.mark === 'todo' ? '•' : '○'}</span>{' '}
            <strong>{step.name}</strong>
            {step.mark !== 'done' && <span className="url"> {step.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
