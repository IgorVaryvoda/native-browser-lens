import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { SetupStatus } from '@/protocol/SetupStatus';
import { CopyIcon, DoneIcon } from '@/ui/icons';
import { useStored } from './Record';

const RELEASES = 'https://github.com/VKrachun/native-browser-lens/releases/latest/download';

/** The install line for this computer, as the release pages publish it. */
function installCommand(os: string) {
  return os === 'win'
    ? { shell: 'PowerShell', command: `irm ${RELEASES}/install.ps1 | iex` }
    : { shell: os === 'mac' ? 'Terminal' : 'a terminal', command: `curl -fsSL ${RELEASES}/install.sh | sh` };
}

/** The browser's "host not found" means the app is not installed; anything else, that it failed. */
export const appMissing = (reason: string) => /not found/i.test(reason);

/**
 * Shown while the extension cannot reach the Lens app: the one line that installs it, and a wait
 * that ends by itself when the app answers.
 */
export function InstallApp({ reason }: { reason: string }) {
  const [os, setOs] = useState('linux');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void browser.runtime.getPlatformInfo().then((info) => setOs(info.os));
  }, []);
  const missing = appMissing(reason);
  const { shell, command } = installCommand(os);
  return (
    <section className="card onboarding" aria-label="Install the Lens app">
      <h2>{missing ? 'Install the Lens app' : 'The Lens app did not start'}</h2>
      {missing ? (
        <p className="muted">
          Lens records what you do on a site, with your voice, and files it as a task an agent can repeat. The app keeps
          the recordings on this computer. It installs for you only, without administrator rights.
        </p>
      ) : (
        <p className="muted">
          It is installed, but the browser could not start it: <em>{reason}</em>. Run the install line again to repair it,
          or <code>lens doctor</code> to see what is wrong.
        </p>
      )}
      <ol className="install-steps">
        <li>Open {shell}.</li>
        <li>
          Paste this line and press Enter:
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
        </li>
        <li>Come back here. This panel continues by itself.</li>
      </ol>
      <p className="waiting small muted" role="status" aria-label="Waiting for the app">
        <span className="spinner" aria-hidden="true" />
        Waiting for the app
      </p>
    </section>
  );
}

/**
 * What is left to set up, as actions. The panel itself covers the extension, the site and the
 * first recording, so only what lives elsewhere shows: starting at login, and VibeQ (optional,
 * dismissible).
 */
export function SetupCard({ client, refresh }: { client: LensClient; refresh: number }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [vibeqHidden, setVibeqHidden] = useStored('lens.setup.vibeqHidden', false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      client
        .request({ method: 'setupStatus' })
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, refresh]);
  if (!status) return null;
  const login = status.steps.find((s) => s.name === 'Starts at login');
  const vibeq = status.steps.find((s) => s.name === 'VibeQ');
  const needsLogin = login?.mark === 'todo';
  const needsVibeq = vibeq?.mark === 'optional' && !vibeqHidden;
  if (!needsLogin && !needsVibeq) return null;

  async function turnOn() {
    setTurningOn(true);
    setProblem(null);
    try {
      // The app restarts under the service manager; this panel reconnects by itself.
      await client.request({ method: 'installService' });
    } catch (error) {
      setProblem(`Lens did not turn it on: ${(error as Error).message}. Run lens service install in a terminal.`);
      setTurningOn(false);
    }
  }

  return (
    <section className="card setup" aria-label="Setup">
      <ul>
        {needsLogin && (
          <li data-mark="todo">
            <span className="setup-text">
              <strong>Start Lens at login</strong>
              <span className="small muted">So recordings and filing keep working after a restart.</span>
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void turnOn()} disabled={turningOn}>
              {turningOn ? 'Turning on…' : 'Turn on'}
            </button>
          </li>
        )}
        {needsVibeq && (
          <li data-mark="optional">
            <span className="setup-text">
              <strong>File tasks to VibeQ</strong>
              <span className="small muted">Optional. Without it, you can still export reviews.</span>
            </span>
            <span className="setup-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void browser.runtime.openOptionsPage()}>
                Sign in
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label="Hide the VibeQ suggestion"
                title="Hide"
                onClick={() => setVibeqHidden(true)}
              >
                Not now
              </button>
            </span>
          </li>
        )}
      </ul>
      {problem && (
        <p role="alert" className="small">
          {problem}
        </p>
      )}
    </section>
  );
}
