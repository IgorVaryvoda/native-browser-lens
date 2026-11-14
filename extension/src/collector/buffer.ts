import type { CaptureMode } from '@/protocol/CaptureMode';
import type { CoverageGap } from '@/protocol/CoverageGap';
import type { EvidenceEvent } from '@/protocol/EvidenceEvent';
import { sanitize } from './sanitize';

export const WINDOW_MS = 120_000;
export const MAX_EVENTS = 256;
export const MAX_EVENT_BYTES = 24 * 1024;
export const MAX_BUFFER_BYTES = 384 * 1024;
const MAX_GAPS = 40;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

interface Entry {
  mode: CaptureMode;
  events: { event: EvidenceEvent; size: number }[];
  size: number;
  gaps: CoverageGap[];
}

/** The last two minutes of evidence for each collected tab, within count and byte budgets. */
export class EvidenceBuffer {
  private readonly tabs = new Map<number, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  start(tabId: number, mode: CaptureMode) {
    const entry = this.tabs.get(tabId);
    if (entry) entry.mode = mode;
    else this.tabs.set(tabId, { mode, events: [], size: 0, gaps: [] });
  }

  stop(tabId: number) {
    this.tabs.delete(tabId);
  }

  mode(tabId: number): CaptureMode | undefined {
    return this.tabs.get(tabId)?.mode;
  }

  /** A new document in the tab: the old page's evidence no longer describes what is on screen. */
  reset(tabId: number) {
    const entry = this.tabs.get(tabId);
    if (entry) Object.assign(entry, { events: [], size: 0, gaps: [] });
  }

  record(tabId: number, kind: string, data: Record<string, unknown>) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    let event: EvidenceEvent = { timestamp: this.now(), kind, data: sanitize(data) as EvidenceEvent['data'] };
    let size = bytes(event);
    if (size > MAX_EVENT_BYTES) {
      event = { timestamp: event.timestamp, kind, data: { omission: `Event of ${size} bytes exceeds 24 KiB` } };
      size = bytes(event);
    }
    entry.events.push({ event, size });
    entry.size += size;
    this.prune(tabId, entry);
  }

  gap(tabId: number, channel: string, reason: string) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    const open = entry.gaps.find((g) => g.channel === channel && g.reason === reason);
    if (open) open.endedAt = this.now();
    else entry.gaps.push({ channel, reason, startedAt: this.now(), endedAt: null });
    if (entry.gaps.length > MAX_GAPS) entry.gaps.shift();
  }

  snapshot(tabId: number) {
    const entry = this.tabs.get(tabId);
    if (!entry) return undefined;
    this.prune(tabId, entry);
    return { mode: entry.mode, events: entry.events.map((e) => e.event), gaps: [...entry.gaps] };
  }

  private prune(tabId: number, entry: Entry) {
    const cutoff = this.now() - WINDOW_MS;
    while (entry.events.length && entry.events[0]!.event.timestamp < cutoff) entry.size -= entry.events.shift()!.size;
    let evicted = false;
    while (entry.events.length > MAX_EVENTS || entry.size > MAX_BUFFER_BYTES) {
      entry.size -= entry.events.shift()!.size;
      evicted = true;
    }
    if (evicted) this.gap(tabId, 'buffer', 'Oldest evidence evicted by the count or byte budget');
  }
}
