import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { SetupStatus } from '@/protocol/SetupStatus';
import { AlertIcon, CopyIcon, DoneIcon } from '@/ui/icons';

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
    <section className="card onboarding" aria-label="Install the Lens app">
      <h2>{missing ? 'One more step: the Lens app' : 'Lens did not start'}</h2>
      {missing ? (
        <p className="muted">
          The extension collects evidence. The Lens app on this computer keeps your notebook, its screenshots and your
          filings. Open {shell}, paste this line and press Enter.
        </p>
      ) : (
        <p className="muted">
          The app is installed but stopped: <em>{reason}</em>. Running the line again repairs it; <code>lens doctor</code>{' '}
          shows what is wrong.
        </p>
      )}
      <div className="command">
        <code>{command}</code>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
        >
          {copied ? <DoneIcon size={14} /> : <CopyIcon size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="waiting small muted" role="status" aria-label="Waiting for the app">
        <span className="spinner" aria-hidden="true" />
        Waiting for the app; this panel continues by itself.
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
  const required = status.steps.filter((s) => s.mark !== 'optional');
  if (!required.some((s) => s.mark === 'todo')) return null;
  const done = required.filter((s) => s.mark === 'done').length;
  return (
    <section className="card setup" aria-label="Setup">
      <div className="setup-head">
        <h2>Finish setting up</h2>
        <span className="small muted num">
          {done} of {required.length}
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        <span style={{ width: `${(done / required.length) * 100}%` }} />
      </div>
      <ul>
        {status.steps.filter((step) => step.mark !== 'done').map((step) => (
          <li key={step.name} data-mark={step.mark}>
            <span className="step-mark" aria-hidden="true">
              {step.mark === 'done' ? <DoneIcon size={16} /> : step.mark === 'todo' ? <AlertIcon size={16} /> : null}
            </span>
            <span>
              <strong>{step.name}</strong>
              {step.mark !== 'done' && <span className="step-detail small muted">{step.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
