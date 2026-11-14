import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { LensError, type LensClient } from '@/lens-client';
import type { Observation } from '@/protocol/Observation';

const AUTOSAVE_MS = 800;

type SaveState =
  | { kind: 'saved' }
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'failed'; message: string }
  | { kind: 'conflict' };

/** Title and notes of one observation. A failed or conflicting save never drops the draft. */
export function Notes({
  client,
  id,
  onSaved,
  appendRef,
}: {
  client: LensClient;
  id: number;
  onSaved: () => void;
  /** Filled with a function that adds text at the end of the notes, for transcripts. */
  appendRef?: RefObject<((text: string) => void) | null>;
}) {
  const [record, setRecord] = useState<Observation | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [state, setState] = useState<SaveState>({ kind: 'saved' });
  const saving = useRef(false);
  const dirty = record !== null && (title !== record.title || notes !== record.notes);
  if (appendRef) {
    appendRef.current = (text: string) => {
      setNotes((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text));
      setState((s) => (s.kind === 'conflict' ? s : { kind: 'editing' }));
    };
  }

  const load = useCallback(async () => {
    const found = await client.request({ method: 'getObservation', params: { id } });
    setRecord(found);
    setTitle(found.title);
    setNotes(found.notes);
    setState({ kind: 'saved' });
  }, [client, id]);

  useEffect(() => {
    void load().catch((error: Error) => setState({ kind: 'failed', message: error.message }));
  }, [load]);

  const save = useCallback(async () => {
    if (!record || !dirty || saving.current || !title.trim()) return;
    saving.current = true;
    setState({ kind: 'saving' });
    try {
      const saved = await client.request({
        method: 'updateObservation',
        params: { id, revision: record.revision, title, notes },
      });
      setRecord(saved);
      // Typing during the save leaves a newer draft: the effect below saves it next.
      setState(saved.title === title && saved.notes === notes ? { kind: 'saved' } : { kind: 'editing' });
      onSaved();
    } catch (error) {
      const conflict = error instanceof LensError && error.code === 'conflict';
      setState(conflict ? { kind: 'conflict' } : { kind: 'failed', message: (error as Error).message });
    } finally {
      saving.current = false;
    }
  }, [client, id, record, dirty, title, notes, onSaved]);

  useEffect(() => {
    if (!dirty || state.kind === 'conflict' || state.kind === 'saving') return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, title, notes, state.kind, save]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('beforeunload', leave);
    };
  }, [save, dirty]);

  if (!record) return state.kind === 'failed' ? <p role="alert" className="notice">{state.message}</p> : null;
  const editing = (s: SaveState) => (s.kind === 'conflict' ? s : ({ kind: 'editing' } as SaveState));
  return (
    <div className="notes">
      <input
        className="input input-quiet title-input"
        aria-label="Title"
        value={title}
        onChange={(e) => (setTitle(e.target.value), setState(editing))}
      />
      <div className="field">
        <div className="notes-head">
          <label htmlFor={`notes-${id}`} className="label">
            Notes
          </label>
          <span className="small muted" role="status" aria-label="Notes status">
            {state.kind === 'saved' && 'Saved'}
            {state.kind === 'editing' && (title.trim() ? 'Unsaved changes' : 'A title is required')}
            {state.kind === 'saving' && 'Saving…'}
          </span>
        </div>
        <textarea
          id={`notes-${id}`}
          className="textarea"
          rows={5}
          value={notes}
          placeholder="What did you do, what happened, and what did you expect?"
          onChange={(e) => (setNotes(e.target.value), setState(editing))}
        />
      </div>
      {state.kind === 'failed' && (
        <div role="alert" className="notice">
          <span>
            Not saved: {state.message}. Your text is still here.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void save()}>
              Try again
            </button>
          </span>
        </div>
      )}
      {state.kind === 'conflict' && (
        <div role="alert" className="notice" data-tone="warning">
          <span>
            This observation changed in another window. Your text is still here.{' '}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void load()}>
              Discard mine and load theirs
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
