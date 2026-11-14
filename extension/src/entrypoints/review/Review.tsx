import { useEffect, useState } from 'react';
import { LensClient } from '@/lens-client';
import type { Capture } from '@/protocol/Capture';
import type { Observation } from '@/protocol/Observation';
import type { Review as FrozenReview } from '@/protocol/Review';
import type { BlobRef } from '@/protocol/BlobRef';
import type { Filing } from '@/protocol/Filing';
import type { Member } from '@/protocol/Member';
import type { AgentInfo } from '@/protocol/AgentInfo';
import type { Agent } from '@/protocol/Agent';
import type { Suggestion } from '@/protocol/Suggestion';
import { AlertIcon, DoneIcon, DraftIcon, ExportIcon, FileIcon, MaskIcon } from '@/ui/icons';

/**
 * Chooses what may leave the notebook. The person confirms the screenshots, the daemon freezes the
 * review and renders the images, and the page then shows exactly those images before any export.
 */
export function Review({ observation: id }: { observation: number }) {
  const [client] = useState(() => new LensClient());
  const [observation, setObservation] = useState<Observation | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [recordings, setRecordings] = useState<Set<number>>(new Set());
  const [checked, setChecked] = useState(false);
  const [review, setReview] = useState<FrozenReview | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [assignee, setAssignee] = useState('');
  const [filing, setFiling] = useState<Filing | null>(null);
  const [sending, setSending] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [drafting, setDrafting] = useState<Agent | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      client.request({ method: 'getObservation', params: { id } }),
      client.request({ method: 'listCaptures', params: { observation: id } }),
    ])
      .then(([found, list]) => {
        setObservation(found);
        setCaptures(list);
        setChosen(new Set(list.map((c) => c.id)));
      })
      .catch((error: Error) => setProblem(error.message));
    return () => client.disconnect();
  }, [client, id]);

  async function freeze() {
    if (!observation) return;
    try {
      const frozen = await client.request({
        method: 'createReview',
        params: {
          observation: observation.id,
          revision: observation.revision,
          captures: captures.filter((c) => chosen.has(c.id)).map((c) => c.id),
          recordings: captures.filter((c) => chosen.has(c.id) && recordings.has(c.id)).map((c) => c.id),
          screenshotsChecked: checked,
        },
      });
      setReview(frozen);
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function file() {
    if (!review) return;
    setSending(true);
    try {
      const done = await client.request({ method: 'fileReview', params: { review: review.id, assignee: assignee || null } });
      setFiling(done);
      setProblem(done.missingFiles ? `${done.missingFiles} files did not reach VibeQ; file again to send them.` : null);
    } catch (error) {
      setProblem(`Not filed: ${(error as Error).message}. Filing again is safe: it never creates a second task.`);
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (!review) return;
    client
      .request({ method: 'listMembers' })
      .then(setMembers)
      .catch(() => setMembers([]));
    client
      .request({ method: 'listAgents' })
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [client, review]);

  async function draft(agent: Agent) {
    if (!review) return;
    setDrafting(agent);
    try {
      setSuggestion(await client.request({ method: 'investigate', params: { review: review.id, agent } }));
      setProblem(null);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setDrafting(null);
    }
  }

  /** The draft replaces the notes: a new revision, so this review no longer matches and is redone. */
  async function useDraft() {
    if (!observation || !suggestion) return;
    try {
      const saved = await client.request({
        method: 'updateObservation',
        params: { id: observation.id, revision: observation.revision, title: observation.title, notes: suggestion.markdown },
      });
      setObservation(saved);
      setReview(null);
      setSuggestion(null);
      setChecked(false);
      setNotice('Your notes now hold the draft. Check them, then create a new review before you file.');
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  async function exportReview() {
    if (!review) return;
    try {
      const done = await client.request({ method: 'exportReview', params: { review: review.id } });
      setExported(done.folder);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!observation) {
    return (
      <main className="page review">
        {problem ? <div role="alert" className="notice">{problem}</div> : <span className="thumb skeleton" />}
      </main>
    );
  }
  const readyAgents = agents.filter((a) => a.state === 'ready');
  const name = (agent: Agent) => (agent === 'codex' ? 'Codex' : 'Claude');
  return (
    <main className="page review">
      <header className="page-head">
        <span className="step-pill pill" data-tone={review ? 'success' : 'info'}>
          {review ? 'Reviewed' : 'Review'}
        </span>
        <h1>{observation.title}</h1>
        {observation.notes ? <p className="notes-text">{observation.notes}</p> : <p className="muted">No notes.</p>}
      </header>

      {notice && (
        <div role="status" className="notice" data-tone="info">
          <DoneIcon />
          <span>{notice}</span>
        </div>
      )}

      {review ? (
        <>
          <section className="section">
            <h2>What leaves your computer</h2>
            <p className="muted small">
              The screenshots below are rendered with your marks, and masks are burned in. Evidence is redacted.
            </p>
          </section>
          <ol aria-label="Reviewed captures" className="review-list">
            {review.items.map((item, index) => (
              <li key={item.capture} className="card review-item">
                <BlobImage client={client} blob={item.screenshot} alt={`Reviewed capture ${item.capture}`} />
                <div className="review-side">
                  <a className="small url" href={item.pageUrl} target="_blank" rel="noreferrer">
                    {item.pageUrl}
                  </a>
                  {item.findings.length > 0 ? (
                    <ul aria-label={`Findings of capture ${item.capture}`} className="findings">
                      {item.findings.map((finding, n) => (
                        <li key={n}>
                          <code>{finding}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="small muted">No failed requests, console errors or exceptions.</p>
                  )}
                  <p className="small muted" aria-label={`Files of capture ${item.capture}`}>
                    Files: capture-{index + 1}.png, capture-{index + 1}-evidence.json
                    {item.recording && `, capture-${index + 1}-recording.json`}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          {suggestion && (
            <section aria-label="Draft report" className="card draft">
              <div className="draft-head">
                <h2>
                  <DraftIcon /> Draft from {name(suggestion.agent)}
                </h2>
                <span className="small muted">A suggestion; nothing is saved until you use it.</span>
              </div>
              <pre>{suggestion.markdown}</pre>
              {suggestion.findings.length > 0 && (
                <ul className="findings">
                  {suggestion.findings.map((f, n) => (
                    <li key={n}>
                      <strong>{f.kind}:</strong> {f.text}
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <button type="button" className="btn btn-secondary" onClick={useDraft}>
                  Use as my notes
                </button>
              </div>
            </section>
          )}

          {filing?.taskUrl && (
            <div role="status" aria-label="Filing" className="notice" data-tone="info">
              <DoneIcon />
              <span>
                Filed:{' '}
                <a href={filing.taskUrl} target="_blank" rel="noreferrer">
                  {filing.taskUrl}
                </a>
              </span>
            </div>
          )}
          {exported && (
            <div role="status" aria-label="Export" className="notice" data-tone="info">
              <DoneIcon />
              <span>Exported to {exported}</span>
            </div>
          )}
          {problem && (
            <div role="alert" className="notice">
              <AlertIcon />
              <span>{problem}</span>
            </div>
          )}

          <footer className="action-bar">
            {readyAgents.map((a) => (
              <button
                key={a.agent}
                type="button"
                className="btn btn-ghost"
                onClick={() => void draft(a.agent)}
                disabled={drafting !== null}
              >
                <DraftIcon />
                {drafting === a.agent ? 'Drafting…' : `Draft the report with ${name(a.agent)}`}
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="btn btn-secondary" onClick={exportReview} disabled={exported !== null}>
              <ExportIcon />
              Export to Downloads
            </button>
            {members && members.length > 0 && (
              <label className="assign">
                <span className="small muted">Assign to</span>
                <select
                  className="select"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  disabled={filing !== null}
                >
                  <option value="">Nobody</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={file}
              disabled={sending || (filing !== null && filing.missingFiles === 0)}
            >
              <FileIcon />
              {sending ? 'Filing…' : filing ? 'Filed' : 'File to VibeQ'}
            </button>
          </footer>
        </>
      ) : (
        <>
          <section className="section">
            <h2>Choose what to share</h2>
            <p className="muted small">
              Nothing leaves your computer until you create the review. Check every screenshot for private data; mask it
              in the editor first.
            </p>
          </section>
          <ol aria-label="Captures to review" className="review-list">
            {captures.map((c) => (
              <li key={c.id} className="card review-item" data-excluded={!chosen.has(c.id) || undefined}>
                <BlobImage client={client} blob={c.screenshot} alt={`Capture ${c.id} before review`} />
                <div className="review-side">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={chosen.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setChosen(next);
                      }}
                    />
                    <span>
                      Include capture {c.id}
                      <span className="small muted num" style={{ display: 'block' }}>
                        {c.eventCount} events · {c.annotations.filter((s) => s.kind === 'mask').length} masks
                      </span>
                    </span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void browser.tabs.create({ url: browser.runtime.getURL(`/annotate.html?capture=${c.id}`) })}
                  >
                    <MaskIcon />
                    Mark up or mask
                  </button>
                  {c.recording && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={recordings.has(c.id)}
                        onChange={(e) => {
                          const next = new Set(recordings);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setRecordings(next);
                        }}
                      />
                      <span>
                        Include the DOM recording of capture {c.id}.
                        <span className="small muted" style={{ display: 'block' }}>
                          Masks do not apply to recordings; only typed input is masked.
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {problem && (
            <div role="alert" className="notice">
              <AlertIcon />
              <span>{problem}</span>
            </div>
          )}
          <footer className="action-bar">
            <label className="check confirm">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>I checked every included screenshot and masked what is private.</span>
            </label>
            <span className="spacer" />
            <button type="button" className="btn btn-primary" onClick={freeze} disabled={!checked || chosen.size === 0}>
              Create review
            </button>
          </footer>
        </>
      )}
    </main>
  );
}

function BlobImage({ client, blob, alt }: { client: LensClient; blob: BlobRef; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void client.readBlob(blob).then((data) => setSrc((url = URL.createObjectURL(data))));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, blob]);
  return src ? <img className="review-shot" src={src} alt={alt} /> : <span className="review-shot skeleton" />;
}
