import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';
import './editor.css';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { locatorOf } from '@/collector/actions';
import type { LensClient } from '@/lens-client';
import type { Action } from '@/protocol/Action';
import type { Annotation } from '@/protocol/Annotation';
import type { Capture } from '@/protocol/Capture';
import type { Edits } from '@/protocol/Edits';
import type { Locator } from '@/protocol/Locator';
import type { Point } from '@/protocol/Point';
import type { TimeRange } from '@/protocol/TimeRange';
import type { VoiceNote } from '@/protocol/VoiceNote';
import { AddNoteIcon, DeleteIcon, PenIcon, PlayIcon, StopIcon, TargetIcon } from '@/ui/icons';

type Player = InstanceType<typeof rrwebPlayer>;
type Mark = { at: number; kind: 'step' | 'error' | 'note'; label: string };
type Stroke = Point[];
/** Draw: free lines; Highlight: one element, outlined, under the pointer. */
type Tool = 'draw' | 'highlight' | null;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const describe = (l: Locator | null) => (!l ? 'the page' : l.role && l.name ? `${l.role} “${l.name}”` : l.text ? `“${l.text}”` : l.css);
const ELEMENTS_PER_NOTE = 5;
/** A drawing stays on screen this long around its moment. */
const DRAWING_SHOWS_MS = 2500;

/**
 * The review of a recording: the replay as the video, the person's voice in sync, a timeline
 * with steps, errors, speech and notes, and the edits that decide what leaves: trimmed ends, cut
 * parts, notes at moments and drawings that name the elements under them.
 */
export function RecordingEditor({ client, capture, voice }: { client: LensClient; capture: Capture; voice: VoiceNote[] }) {
  const stage = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const player = useRef<Player | null>(null);
  const [span, setSpan] = useState<{ start: number; end: number } | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [edits, setEdits] = useState<Edits>(capture.edits);
  const [saved, setSaved] = useState(true);
  const [selection, setSelection] = useState<TimeRange | null>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [hover, setHover] = useState<{ x: number; y: number; width: number; height: number; label: string } | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [draft, setDraft] = useState<{ at: number; text: string; drawing: Stroke[]; elements: Locator[] } | null>(null);
  const [steps, setSteps] = useState<{ at: number; text: string; error: boolean }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const audio = useRef<Map<number, HTMLAudioElement>>(new Map());

  // The replay and the steps.
  useEffect(() => {
    if (!capture.recording || !stage.current) return;
    let cancelled = false;
    const target = stage.current;
    void (async () => {
      try {
        const events = JSON.parse(await (await client.readBlob(capture.recording!)).text());
        const evidence = JSON.parse(await (await client.readBlob(capture.evidence)).text()) as {
          actions?: Action[];
          events?: { timestamp: number; kind: string; data: Record<string, unknown> }[];
        };
        if (cancelled) return;
        const width = target.clientWidth;
        const instance = new rrwebPlayer({
          target,
          props: { events, width, height: Math.round(width * 0.5625), autoPlay: false, showController: false, skipInactive: false },
        });
        player.current = instance;
        const meta = instance.getMetaData();
        // A replay starts at the snapshot before the recording; the recording starts at Record.
        setSpan({ start: meta.startTime, end: meta.endTime });
        setNow(Math.max(meta.startTime, capture.startedAt));
        // Seeking once also sets rrweb's base time: before it, getCurrentTime() is not a position.
        instance.goto(Math.max(0, capture.startedAt - meta.startTime), false);
        const failed = (e: { kind: string; data: Record<string, unknown> }) =>
          (e.kind === 'response' && Number(e.data.status) >= 400) ||
          e.kind === 'exception' ||
          e.kind === 'networkFailure' ||
          (e.kind === 'console' && e.data.level === 'error');
        setSteps(
          [
            ...(evidence.actions ?? [])
              .filter((a) => a.kind !== 'scroll')
              .map((a) => ({ at: a.timestamp, text: `${a.kind} ${describe(a.target)}${a.masked ? ' (private)' : a.value && a.kind !== 'press' ? ` “${a.value}”` : a.value ? ` ${a.value}` : ''}`, error: false })),
            ...(evidence.events ?? []).filter(failed).map((e) => ({
              at: e.timestamp,
              text: e.kind === 'response' ? `HTTP ${e.data.status} ${e.data.url}` : `${e.kind}: ${String(e.data.text ?? e.data.errorText ?? '')}`,
              error: true,
            })),
          ].sort((a, b) => a.at - b.at),
        );
      } catch (error) {
        setProblem(`The recording did not load: ${(error as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
      player.current?.pause();
      player.current?.getReplayer().destroy();
      player.current = null;
      target.replaceChildren();
    };
  }, [client, capture.recording, capture.evidence]);

  // One clock: the replay's time drives the voice and the drawings.
  useEffect(() => {
    if (!span) return;
    let frame = 0;
    const tick = () => {
      // The next frame is asked for first: one failure must not stop the clock for good.
      frame = requestAnimationFrame(tick);
      let replayer: ReturnType<Player['getReplayer']> | undefined;
      try {
        replayer = player.current?.getReplayer();
      } catch {
        return;
      }
      if (replayer) {
        const offset = replayer.getCurrentTime();
        if (!(offset >= 0 && offset <= span.end - span.start + 1000)) return;
        const at = Math.round(span.start + offset);
        setNow(at);
        const kept = keptRanges(edits, { start: Math.max(span.start, capture.startedAt), end: span.end });
        // A cut part plays as if it were not there: the replay jumps over it.
        if (playing) {
          const inCut = !kept.some((r) => at >= r.from && at < r.to);
          if (inCut) {
            const next = kept.find((r) => r.from > at);
            if (next) player.current!.goto(next.from - span.start, true);
            else (player.current!.pause(), setPlaying(false));
          }
        }
        for (const note of voice) {
          const element = audio.current.get(note.id);
          if (!element) continue;
          const offset = (at - Number(note.startedAt)) / 1000;
          const inside = offset >= 0 && offset < Number(note.durationMs) / 1000;
          if (playing && inside) {
            if (Math.abs(element.currentTime - offset) > 0.3) element.currentTime = offset;
            if (element.paused) void element.play().catch(() => {});
          } else if (!element.paused) element.pause();
        }
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [span, playing, edits, voice, capture.startedAt]);

  // The voice recordings, loaded once.
  useEffect(() => {
    const urls: string[] = [];
    for (const note of voice) {
      if (audio.current.has(note.id)) continue;
      void client.readBlob(note.audio).then((blob) => {
        const url = URL.createObjectURL(blob);
        urls.push(url);
        audio.current.set(note.id, new Audio(url));
      });
    }
    return () => {
      for (const element of audio.current.values()) element.pause();
      urls.forEach(URL.revokeObjectURL);
    };
  }, [client, voice]);

  // Edits save shortly after each change.
  useEffect(() => {
    if (saved) return;
    const timer = setTimeout(() => {
      client
        .request({ method: 'saveEdits', params: { capture: capture.id, edits } })
        .then(() => setSaved(true))
        .catch((error: Error) => setProblem(`Not saved: ${error.message}`));
    }, 500);
    return () => clearTimeout(timer);
  }, [client, capture.id, edits, saved]);

  const change = (next: Edits) => (setEdits(next), setSaved(false));
  const seek = useCallback(
    (at: number) => {
      if (!span || !player.current) return;
      player.current.goto(Math.min(Math.max(at, span.start), span.end) - span.start, playing);
      setNow(at);
    },
    [span, playing],
  );
  function toggle() {
    if (!player.current || !span) return;
    if (playing) {
      player.current.pause();
      setPlaying(false);
    } else {
      const kept = keptRanges(edits, { start: Math.max(span.start, capture.startedAt), end: span.end });
      const inside = kept.some((r) => now >= r.from && now < r.to - 50);
      player.current.goto((inside ? now : (kept[0]?.from ?? span.start)) - span.start, true);
      setPlaying(true);
    }
  }

  // Speech, as words at their moments.
  const words = useMemo(
    () =>
      voice
        .flatMap((note) => note.segments.map((s) => ({ at: Number(note.startedAt) + Number(s.startMs), end: Number(note.startedAt) + Number(s.endMs), text: s.text })))
        .sort((a, b) => a.at - b.at),
    [voice],
  );
  const caption = words.find((w) => now >= w.at && now <= w.end + 500)?.text;

  // Drawing and highlighting over the replay. Shapes are kept in the recorded page's CSS pixels.
  const frameGeometry = () => {
    const iframe = stage.current?.querySelector('iframe');
    if (!iframe) return null;
    const rect = iframe.getBoundingClientRect();
    // offsetWidth is the page's own width; the rect is scaled by the player's transform.
    return { iframe, rect, scale: rect.width / (iframe.offsetWidth || rect.width) };
  };
  useEffect(() => {
    const canvas = overlay.current;
    if (!canvas) return;
    // The canvas covers the stage; its own box is the one to size and to draw against.
    const box = canvas.getBoundingClientRect();
    const ratio = devicePixelRatio || 1;
    if (canvas.width !== Math.round(box.width * ratio) || canvas.height !== Math.round(box.height * ratio)) {
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
    }
    const context = canvas.getContext('2d')!;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    const geometry = frameGeometry();
    if (!geometry) return;
    const toCanvas = (p: Point) => ({
      x: geometry.rect.left - box.left + p.x * geometry.scale,
      y: geometry.rect.top - box.top + p.y * geometry.scale,
    });
    const line = (stroke: Stroke, color: string, width: number) => {
      context.strokeStyle = color;
      context.lineWidth = width;
      context.lineCap = context.lineJoin = 'round';
      context.beginPath();
      stroke.forEach((p, i) => {
        const at = toCanvas(p);
        if (i) context.lineTo(at.x, at.y);
        else context.moveTo(at.x, at.y);
      });
      context.stroke();
    };
    const visible = [
      ...edits.annotations.filter((a) => Math.abs(now - Number(a.at)) < DRAWING_SHOWS_MS).flatMap((a) => a.drawing),
      ...(draft?.drawing ?? []),
      ...strokes,
    ];
    for (const stroke of visible) {
      // A light halo under the red line keeps it readable on dark and light pages.
      line(stroke, 'rgba(255,255,255,0.9)', 6);
      line(stroke, '#ff2d55', 3);
    }
    if (hover) {
      const a = toCanvas({ x: hover.x, y: hover.y });
      const w = hover.width * geometry.scale;
      const h = hover.height * geometry.scale;
      context.fillStyle = 'rgba(0, 85, 240, 0.16)';
      context.fillRect(a.x, a.y, w, h);
      context.strokeStyle = '#0055f0';
      context.lineWidth = 2;
      context.strokeRect(a.x, a.y, w, h);
      context.font = '600 12px Inter, system-ui, sans-serif';
      const label = hover.label;
      const textWidth = context.measureText(label).width + 12;
      const top = a.y >= 24 ? a.y - 22 : a.y + h + 2;
      context.fillStyle = '#0055f0';
      context.fillRect(a.x, top, textWidth, 20);
      context.fillStyle = '#fff';
      context.fillText(label, a.x + 6, top + 14);
    }
  });

  const toPage = (event: ReactPointerEvent) => {
    const geometry = frameGeometry();
    if (!geometry) return null;
    return { x: (event.clientX - geometry.rect.left) / geometry.scale, y: (event.clientY - geometry.rect.top) / geometry.scale };
  };
  /** The element a person means at a point of the replay: the nearest control or text block. */
  function elementAt(p: Point): Element | null {
    const doc = frameGeometry()?.iframe.contentDocument;
    const at = doc?.elementFromPoint(p.x, p.y);
    if (!doc || !at || at === doc.body || at === doc.documentElement) return null;
    return at.closest('a,button,input,select,textarea,label,[role],[data-testid],h1,h2,h3,h4,h5,h6,img,li,td,p') ?? at;
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const p = toPage(event);
    if (!p) return;
    if (tool === 'highlight') {
      const target = elementAt(p);
      if (!target) return;
      const r = target.getBoundingClientRect();
      const box: Stroke = [
        { x: r.left, y: r.top },
        { x: r.right, y: r.top },
        { x: r.right, y: r.bottom },
        { x: r.left, y: r.bottom },
        { x: r.left, y: r.top },
      ];
      setTool(null);
      setHover(null);
      return startNote([box], [locatorOf(target)]);
    }
    if (tool !== 'draw') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setStrokes((s) => [...s, [p]]);
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const p = toPage(event);
    if (!p) return;
    if (tool === 'highlight') {
      const target = elementAt(p);
      if (!target) return setHover(null);
      const r = target.getBoundingClientRect();
      const name = describe(locatorOf(target));
      return setHover({ x: r.left, y: r.top, width: r.width, height: r.height, label: name.length > 60 ? `${name.slice(0, 57)}…` : name });
    }
    if (tool !== 'draw' || !(event.buttons & 1)) return;
    setStrokes((s) => (s.length ? [...s.slice(0, -1), [...s.at(-1)!, p].slice(0, 2000)] : s));
  }
  /** The page elements under a drawing, found in the replay's own DOM. */
  function elementsUnder(lines: Stroke[]): Locator[] {
    const found = new Map<string, Locator>();
    for (const p of lines.flatMap((line) => line.filter((_, i) => i % 6 === 0))) {
      const target = elementAt(p);
      if (!target) continue;
      const locator = locatorOf(target);
      if (!found.has(locator.css)) found.set(locator.css, locator);
      if (found.size >= ELEMENTS_PER_NOTE) break;
    }
    return [...found.values()];
  }

  function startNote(withDrawing: Stroke[] = [], elements?: Locator[]) {
    player.current?.pause();
    setPlaying(false);
    setDraft({ at: now, text: '', drawing: withDrawing, elements: elements ?? (withDrawing.length ? elementsUnder(withDrawing) : []) });
  }
  function choose(next: Tool) {
    if (tool === 'draw' && strokes.length) startNote(strokes);
    setStrokes([]);
    setHover(null);
    if (next && next !== tool) {
      player.current?.pause();
      setPlaying(false);
    }
    setTool(next === tool ? null : next);
  }
  function saveNote() {
    if (!draft || (!draft.text.trim() && !draft.drawing.length)) return setDraft(null);
    const note: Annotation = { id: crypto.randomUUID(), at: draft.at, text: draft.text.trim(), drawing: draft.drawing, elements: draft.elements };
    change({ ...edits, annotations: [...edits.annotations, note].sort((a, b) => Number(a.at) - Number(b.at)) });
    setDraft(null);
  }

  // The timeline: click to seek, drag to select a part to cut, handles to trim the ends.
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ from: number; moved: boolean } | null>(null);
  const timeAt = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return span ? Math.round(span.start + share * (span.end - span.start)) : 0;
  };
  const left = (at: number) => (span ? `${((at - span.start) / Math.max(1, span.end - span.start)) * 100}%` : '0%');
  function trackDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).dataset.handle) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = { from: timeAt(event.clientX), moved: false };
  }
  function trackMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    if (!drag) return;
    const at = timeAt(event.clientX);
    if (Math.abs(at - drag.from) > (span ? (span.end - span.start) / 200 : 0)) drag.moved = true;
    if (drag.moved) setSelection({ from: Math.min(drag.from, at), to: Math.max(drag.from, at) });
  }
  function trackUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragging.current;
    dragging.current = null;
    if (drag && !drag.moved) {
      setSelection(null);
      seek(timeAt(event.clientX));
    }
  }
  function trim(which: 'trimStart' | 'trimEnd', event: ReactPointerEvent<HTMLSpanElement>) {
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const at = Math.round(timeAt(e.clientX));
      setEdits((current) => ({ ...current, [which]: at }));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      setSaved(false);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  }

  if (!capture.recording) return null;
  const marks: Mark[] = [
    ...steps.map((s) => ({ at: s.at, kind: s.error ? ('error' as const) : ('step' as const), label: s.text })),
    ...edits.annotations.map((a) => ({ at: Number(a.at), kind: 'note' as const, label: a.text || 'Drawing' })),
  ];
  const trimStart = edits.trimStart ?? Math.max(span?.start ?? 0, capture.startedAt);
  const trimEnd = edits.trimEnd ?? span?.end ?? 0;
  const kept = span ? keptRanges(edits, { start: Math.max(span.start, capture.startedAt), end: span.end }) : [];
  const keptMs = kept.reduce((sum, r) => sum + (r.to - r.from), 0);

  return (
    <section className="editor" aria-label="Recording editor">
      <div className="editor-main">
        <div className="stage-wrap">
          <div ref={stage} className="stage" />
          <canvas
            ref={overlay}
            className="draw-layer"
            data-tool={tool ?? undefined}
            aria-label={tool ? 'Drawing layer' : undefined}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerLeave={() => setHover(null)}
          />
          {caption && <p className="caption">{caption}</p>}
        </div>

        <div className="controls" role="toolbar" aria-label="Playback">
          <button type="button" className="btn btn-secondary btn-icon" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle} disabled={!span}>
            {playing ? <StopIcon /> : <PlayIcon />}
          </button>
          <span className="num small" aria-label="Time">
            {span ? `${clock(now - span.start)} / ${clock(span.end - span.start)}` : '…'}
          </span>
          <span className="spacer" />
          {selection ? (
            <>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => (change({ ...edits, cuts: [...edits.cuts, selection] }), setSelection(null))}
              >
                Cut {clock(selection.to - selection.from)} out
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelection(null)}>
                Clear
              </button>
            </>
          ) : (
            <span className="small muted">Drag on the timeline to cut a part</span>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => startNote()} disabled={!span}>
            <AddNoteIcon /> Note
          </button>
          <button
            type="button"
            className={tool === 'highlight' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={tool === 'highlight'}
            title="Point at an element and click it"
            onClick={() => choose('highlight')}
            disabled={!span}
          >
            <TargetIcon /> {tool === 'highlight' ? 'Click an element' : 'Highlight'}
          </button>
          <button
            type="button"
            className={tool === 'draw' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={tool === 'draw'}
            onClick={() => choose('draw')}
            disabled={!span}
          >
            <PenIcon /> {tool === 'draw' ? 'Done drawing' : 'Draw'}
          </button>
        </div>

        <div
          ref={track}
          className="timeline"
          aria-label="Timeline"
          onPointerDown={trackDown}
          onPointerMove={trackMove}
          onPointerUp={trackUp}
        >
          {span && (
            <>
              <span className="trimmed" style={{ left: 0, width: left(trimStart) }} />
              <span className="trimmed" style={{ left: left(trimEnd), right: 0 }} />
              {edits.cuts.map((c, i) => (
                <span key={i} className="cut" style={{ left: left(c.from), width: `calc(${left(c.to)} - ${left(c.from)})` }}>
                  <button
                    type="button"
                    className="cut-remove"
                    aria-label="Restore this part"
                    title="Restore this part"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => change({ ...edits, cuts: edits.cuts.filter((_, j) => j !== i) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              {words.map((w, i) => (
                <span key={`w${i}`} className="speech" style={{ left: left(w.at), width: `calc(${left(w.end)} - ${left(w.at)})` }} title={w.text} />
              ))}
              {marks.map((m, i) => (
                <span key={`m${i}`} className="mark" data-kind={m.kind} style={{ left: left(m.at) }} title={m.label} />
              ))}
              {selection && (
                <span className="selection" style={{ left: left(selection.from), width: `calc(${left(selection.to)} - ${left(selection.from)})` }} />
              )}
              <span className="handle" data-handle="start" style={{ left: left(trimStart) }} onPointerDown={(e) => trim('trimStart', e)} title="Drag to trim the start" />
              <span className="handle" data-handle="end" style={{ left: left(trimEnd) }} onPointerDown={(e) => trim('trimEnd', e)} title="Drag to trim the end" />
              <span className="playhead" style={{ left: left(now) }} />
            </>
          )}
        </div>
        <p className="small muted num" role="status" aria-label="Edits">
          {span && `${clock(keptMs)} of ${clock(span.end - span.start)} kept · ${edits.annotations.length} notes · ${saved ? 'Saved' : 'Saving…'}`}
        </p>

        {draft && (
          <div className="note-draft card" role="dialog" aria-label="New note">
            <span className="small muted num">
              At {span ? clock(draft.at - span.start) : ''}
              {draft.elements.length ? ` · marks ${draft.elements.map(describe).join(', ')}` : ''}
            </span>
            <textarea
              className="textarea"
              rows={2}
              autoFocus
              aria-label="Note"
              placeholder="What is wrong here, and what did you expect?"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={(e) => (e.key === 'Enter' && (e.metaKey || e.ctrlKey) ? saveNote() : undefined)}
            />
            <div className="note-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(null)}>
                Discard
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={saveNote}>
                Add note
              </button>
            </div>
          </div>
        )}
        {problem && (
          <div role="alert" className="notice">
            {problem}
          </div>
        )}
      </div>

      <aside className="editor-side">
        <section aria-label="Transcript">
          <h3 className="label">Your voice</h3>
          {words.length ? (
            <ol className="lines">
              {words.map((w, i) => (
                <li key={i} data-current={now >= w.at && now <= w.end + 500 || undefined}>
                  <button type="button" className="line" onClick={() => seek(w.at)}>
                    <span className="num muted">{span ? clock(w.at - span.start) : ''}</span> {w.text}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">
              {voice.some((v) => v.state !== 'done') ? 'Writing down what you said…' : 'No voice in this recording.'}
            </p>
          )}
        </section>
        <section aria-label="Notes">
          <h3 className="label">Notes</h3>
          {edits.annotations.length ? (
            <ol className="lines">
              {edits.annotations.map((a) => (
                <li key={a.id}>
                  <button type="button" className="line" onClick={() => seek(Number(a.at))}>
                    <span className="num muted">{span ? clock(Number(a.at) - span.start) : ''}</span> {a.text || 'Drawing'}
                    {a.elements.length > 0 && <span className="muted"> · {a.elements.map(describe).join(', ')}</span>}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label="Delete note"
                    onClick={() => change({ ...edits, annotations: edits.annotations.filter((x) => x.id !== a.id) })}
                  >
                    <DeleteIcon />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">Pause where something is wrong and add a note, or draw on it.</p>
          )}
        </section>
        <section aria-label="Steps">
          <h3 className="label">Steps and errors</h3>
          <ol className="lines">
            {steps.map((s, i) => (
              <li key={i} data-error={s.error || undefined}>
                <button type="button" className="line" onClick={() => seek(s.at)}>
                  <span className="num muted">{span ? clock(s.at - span.start) : ''}</span> {s.text}
                </button>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </section>
  );
}

function keptRanges(edits: Edits, span: { start: number; end: number }): TimeRange[] {
  const from = Math.max(edits.trimStart ?? span.start, span.start);
  const to = Math.min(edits.trimEnd ?? span.end, span.end);
  const cuts = [...edits.cuts].sort((a, b) => a.from - b.from);
  const kept: TimeRange[] = [];
  let cursor = from;
  for (const cut of cuts) {
    if (cut.to <= cursor || cut.from >= to) continue;
    if (cut.from > cursor) kept.push({ from: cursor, to: cut.from });
    cursor = Math.max(cursor, cut.to);
  }
  if (cursor < to) kept.push({ from: cursor, to });
  return kept;
}
