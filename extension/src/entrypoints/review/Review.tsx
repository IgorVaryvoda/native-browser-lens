import { useEffect, useState } from 'react';
import { LensClient } from '@/lens-client';
import type { Capture } from '@/protocol/Capture';
import type { Observation } from '@/protocol/Observation';
import type { Review as FrozenReview } from '@/protocol/Review';
import type { BlobRef } from '@/protocol/BlobRef';

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

  async function exportReview() {
    if (!review) return;
    try {
      const done = await client.request({ method: 'exportReview', params: { review: review.id } });
      setExported(done.folder);
    } catch (error) {
      setProblem((error as Error).message);
    }
  }

  if (!observation) return <main className="review">{problem && <p role="alert">{problem}</p>}</main>;
  return (
    <main className="review">
      <h1>{observation.title}</h1>
      {observation.notes && <p className="notes-text">{observation.notes}</p>}
      {review ? (
        <>
          <h2>Reviewed: this is what leaves your computer</h2>
          <ol aria-label="Reviewed captures">
            {review.items.map((item, index) => (
              <li key={item.capture}>
                <p className="url">{item.pageUrl}</p>
                <BlobImage client={client} blob={item.screenshot} alt={`Reviewed capture ${item.capture}`} />
                {item.findings.length > 0 && (
                  <ul aria-label={`Findings of capture ${item.capture}`}>
                    {item.findings.map((finding, n) => (
                      <li key={n}>
                        <code>{finding}</code>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="facts" aria-label={`Files of capture ${item.capture}`}>
                  Files: capture-{index + 1}.png, capture-{index + 1}-evidence.json (redacted network, console and
                  errors)
                  {item.recording && `, capture-${index + 1}-recording.json (DOM recording, typed input masked)`}
                </p>
              </li>
            ))}
          </ol>
          <div className="actions">
            <button type="button" className="primary" onClick={exportReview} disabled={exported !== null}>
              Export to Downloads
            </button>
          </div>
          {exported && (
            <p role="status" aria-label="Export">
              Exported to {exported}
            </p>
          )}
        </>
      ) : (
        <>
          <ol aria-label="Captures to review">
            {captures.map((c) => (
              <li key={c.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setChosen(next);
                    }}
                  />{' '}
                  Include capture {c.id} · {c.eventCount} events · {c.annotations.filter((s) => s.kind === 'mask').length} masks
                </label>
                <BlobImage client={client} blob={c.screenshot} alt={`Capture ${c.id} before review`} />
                {c.recording && (
                  <label>
                    <input
                      type="checkbox"
                      checked={recordings.has(c.id)}
                      onChange={(e) => {
                        const next = new Set(recordings);
                        if (e.target.checked) next.add(c.id);
                        else next.delete(c.id);
                        setRecordings(next);
                      }}
                    />{' '}
                    Include the DOM recording of capture {c.id}. Masks do not apply to recordings; only typed input is
                    masked.
                  </label>
                )}
              </li>
            ))}
          </ol>
          <label className="confirm">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />I checked every
            included screenshot and masked what is private.
          </label>
          <div className="actions">
            <button type="button" className="primary" onClick={freeze} disabled={!checked || chosen.size === 0}>
              Create review
            </button>
          </div>
        </>
      )}
      {problem && <p role="alert">{problem}</p>}
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
  return src ? <img src={src} alt={alt} /> : <div className="placeholder" />;
}
