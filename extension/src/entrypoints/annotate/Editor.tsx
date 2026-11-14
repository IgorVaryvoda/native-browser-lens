import type Konva from 'konva';
import { getStroke } from 'perfect-freehand';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Arrow, Image as KonvaImage, Layer, Line, Rect, Stage } from 'react-konva';
import { LensClient } from '@/lens-client';
import type { Broadcast } from '@/messages';
import type { Capture } from '@/protocol/Capture';
import type { Point } from '@/protocol/Point';
import type { Shape } from '@/protocol/Shape';

type Tool = 'rectangle' | 'arrow' | 'pen' | 'mask';
const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: 'rectangle', label: 'Rectangle', key: 'r' },
  { tool: 'arrow', label: 'Arrow', key: 'a' },
  { tool: 'pen', label: 'Pen', key: 'p' },
  { tool: 'mask', label: 'Mask', key: 'm' },
];
const COLORS = ['#ff3355', '#ffb000', '#2f7bff'];
const MIN_SIZE = 4;

/** Draws marks on a copy of the screenshot. Shapes are stored in the screenshot's own pixels. */
export function Editor({ capture: captureId }: { capture: number }) {
  const [client] = useState(() => new LensClient());
  const [capture, setCapture] = useState<Capture | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [history, setHistory] = useState<Shape[][]>([[]]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [tool, setTool] = useState<Tool>('rectangle');
  const [color, setColor] = useState(COLORS[0]!);
  const [saved, setSaved] = useState<Shape[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth - 32);
  const shapes = history[history.length - 1]!;
  const dirty = JSON.stringify(shapes) !== JSON.stringify(saved);

  useEffect(() => {
    let url: string | null = null;
    client
      .request({ method: 'getCapture', params: { id: captureId } })
      .then(async (found) => {
        setCapture(found);
        setHistory([found.annotations]);
        setSaved(found.annotations);
        url = URL.createObjectURL(await client.readBlob(found.screenshot));
        const img = new window.Image();
        img.onload = () => setImage(img);
        img.src = url;
      })
      .catch((error: Error) => setProblem(error.message));
    const resize = () => setWidth(window.innerWidth - 32);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (url) URL.revokeObjectURL(url);
      client.disconnect();
    };
  }, [client, captureId]);

  const commit = (next: Shape[]) => setHistory((h) => [...h, next]);
  const undo = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);

  const save = useCallback(async () => {
    try {
      const updated = await client.request({ method: 'saveAnnotations', params: { capture: captureId, shapes } });
      setSaved(updated.annotations);
      setProblem(null);
      void browser.runtime.sendMessage({ kind: 'annotated', capture: updated } satisfies Broadcast).catch(() => {});
    } catch (error) {
      setProblem(`Not saved: ${(error as Error).message}`);
    }
  }, [client, captureId, shapes]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === 'z') return event.preventDefault(), undo();
      if (command && event.key.toLowerCase() === 's') return event.preventDefault(), void save();
      const picked = !command && TOOLS.find((t) => t.key === event.key.toLowerCase());
      if (picked) setTool(picked.tool);
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
  }, [undo, save, dirty]);

  const scale = image ? Math.min(1, width / image.width) : 1;
  const pointer = (stage: Konva.Stage | null): Point | null => {
    const at = stage?.getPointerPosition();
    return at ? { x: at.x / scale, y: at.y / scale } : null;
  };

  function begin(event: Konva.KonvaEventObject<PointerEvent>) {
    const at = pointer(event.target.getStage());
    if (!at) return;
    const box = { x: at.x, y: at.y, width: 0, height: 0 };
    if (tool === 'rectangle') setDraft({ kind: 'rectangle', ...box, color });
    if (tool === 'mask') setDraft({ kind: 'mask', ...box });
    if (tool === 'arrow') setDraft({ kind: 'arrow', from: at, to: at, color });
    if (tool === 'pen') setDraft({ kind: 'pen', points: [at], color });
  }

  function move(event: Konva.KonvaEventObject<PointerEvent>) {
    const at = pointer(event.target.getStage());
    if (!draft || !at) return;
    if (draft.kind === 'rectangle' || draft.kind === 'mask') {
      setDraft({ ...draft, width: at.x - draft.x, height: at.y - draft.y });
    } else if (draft.kind === 'arrow') {
      setDraft({ ...draft, to: at });
    } else if (draft.points.length < 5000) {
      setDraft({ ...draft, points: [...draft.points, at] });
    }
  }

  function end() {
    if (!draft) return;
    const shape = normalized(draft);
    setDraft(null);
    if (shape) commit([...shapes, shape]);
  }

  return (
    <main className="editor">
      <header className="toolbar">
        <h1>{capture ? capture.pageTitle || capture.pageUrl : 'Annotate'}</h1>
        <div role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.tool} type="button" aria-pressed={tool === t.tool} onClick={() => setTool(t.tool)}>
              {t.label}
            </button>
          ))}
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="swatch"
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <button type="button" onClick={undo} disabled={history.length < 2}>
            Undo
          </button>
          <button type="button" className="primary" onClick={save} disabled={!dirty}>
            Save
          </button>
        </div>
        <p role="status" className="mode">
          {dirty ? 'Unsaved changes' : `Saved · ${shapes.length} marks`}
        </p>
        {problem && <p role="alert">{problem}</p>}
      </header>
      {image && (
        <Stage
          width={image.width * scale}
          height={image.height * scale}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          aria-label="Screenshot"
        >
          <Layer scaleX={scale} scaleY={scale}>
            <KonvaImage image={image} />
            {[...shapes, ...(draft ? [draft] : [])].map((shape, index) => (
              <ShapeView key={index} shape={shape} scale={scale} />
            ))}
          </Layer>
        </Stage>
      )}
    </main>
  );
}

/** Positive sizes, and nothing for a click that did not drag. */
function normalized(shape: Shape): Shape | null {
  if (shape.kind === 'rectangle' || shape.kind === 'mask') {
    const box = {
      x: Math.min(shape.x, shape.x + shape.width),
      y: Math.min(shape.y, shape.y + shape.height),
      width: Math.abs(shape.width),
      height: Math.abs(shape.height),
    };
    return box.width < MIN_SIZE || box.height < MIN_SIZE ? null : { ...shape, ...box };
  }
  if (shape.kind === 'arrow') {
    return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < MIN_SIZE ? null : shape;
  }
  return shape.points.length < 2 ? null : shape;
}

function ShapeView({ shape, scale }: { shape: Shape; scale: number }) {
  const line = 3 / scale;
  switch (shape.kind) {
    case 'rectangle':
      return <Rect {...box(shape)} stroke={shape.color} strokeWidth={line} />;
    case 'mask':
      return <Rect {...box(shape)} fill="#000" opacity={0.85} />;
    case 'arrow':
      return (
        <Arrow
          points={[shape.from.x, shape.from.y, shape.to.x, shape.to.y]}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={line}
          pointerLength={12 / scale}
          pointerWidth={12 / scale}
        />
      );
    case 'pen': {
      const outline = getStroke(
        shape.points.map((p) => [p.x, p.y]),
        { size: 4 / scale, thinning: 0.5, smoothing: 0.5 },
      );
      return <Line points={outline.flat()} closed fill={shape.color} />;
    }
  }
}

function box(shape: { x: number; y: number; width: number; height: number }) {
  return { x: shape.x, y: shape.y, width: shape.width, height: shape.height };
}
