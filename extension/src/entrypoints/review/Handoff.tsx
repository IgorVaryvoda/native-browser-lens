import { useEffect, useState } from 'react';
import type { LensClient } from '@/lens-client';
import type { HandoffApp } from '@/protocol/HandoffApp';
import { AlertIcon, DoneIcon } from '@/ui/icons';
import { useStored } from '../sidepanel/Record';

const NAMES: Record<HandoffApp, string> = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
  t3Code: 'T3 Code',
  zeron: 'Zeron',
};

/** What happens in each app after the hand-off. */
const NEXT: Record<HandoffApp, string> = {
  claudeCode: 'Claude Code opens in a terminal with the task. Press Enter to start it.',
  codex: 'Codex opens a new chat with the task. Send it to start.',
  t3Code: 'T3 Code works on it now.',
  zeron: 'Zeron works on it now.',
};

/**
 * Hands the review to a coding agent app on this computer. The project folder is remembered for
 * each site, so the next recording of the same site goes to the same project.
 */
export function Handoff({ client, review, site }: { client: LensClient; review: number; site: string }) {
  const [apps, setApps] = useState<HandoffApp[]>([]);
  const [chosen, setChosen] = useStored<HandoffApp | ''>('lens.handoff.app', '');
  const [folders, setFolders] = useStored<Record<string, string>>('lens.handoff.folders', {});
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ app: HandoffApp; report: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    client
      .request({ method: 'listHandoffApps' })
      .then(setApps)
      .catch(() => setApps([]));
  }, [client]);
  useEffect(() => {
    const saved = folders[site];
    if (saved) setFolder((typed) => typed || saved);
  }, [folders, site]);

  const first = apps[0];
  if (!first) return null;
  const app = chosen && apps.includes(chosen) ? chosen : first;
  const recent = [...new Set(Object.values(folders))];

  async function handOff(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const path = folder.trim();
      const handed = await client.request({ method: 'handOff', params: { review, app, folder: path } });
      setFolders({ ...folders, [site]: path });
      setChosen(app);
      setDone({ app, report: handed.folder });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card handoff" aria-label="Hand off">
      <h2>Hand off to a coding agent</h2>
      <p className="small muted">
        Lens saves the report on this computer and opens the app with the task, in your project's folder.
      </p>
      <form className="handoff-form" onSubmit={(e) => void handOff(e)}>
        <select className="select" aria-label="App" value={app} onChange={(e) => setChosen(e.target.value as HandoffApp)}>
          {apps.map((a) => (
            <option key={a} value={a}>
              {NAMES[a]}
            </option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Project folder"
          placeholder="Project folder, such as /home/you/projects/site"
          list="handoff-folders"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          spellCheck={false}
        />
        <datalist id="handoff-folders">
          {recent.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <button type="submit" className="btn btn-secondary" disabled={busy || !folder.trim()}>
          {busy ? 'Handing off…' : `Hand off to ${NAMES[app]}`}
        </button>
      </form>
      {done && (
        <p className="small" role="status" aria-label="Hand-off">
          <DoneIcon size={14} /> {NEXT[done.app]} The report is in {done.report}.
        </p>
      )}
      {problem && (
        <div role="alert" className="notice">
          <AlertIcon />
          <span>{problem}</span>
        </div>
      )}
    </section>
  );
}
