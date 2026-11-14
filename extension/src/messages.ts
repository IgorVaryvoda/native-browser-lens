import type { Capture } from './protocol/Capture';
import type { CaptureMode } from './protocol/CaptureMode';

/** Side panel → background. */
export type BackgroundRequest =
  | { kind: 'capture'; tabId: number; observation: number | null }
  | { kind: 'tabStatus'; tabId: number }
  | { kind: 'projectsChanged' };

export type CaptureResult = { ok: true; capture: Capture } | { ok: false; error: string };

export interface TabStatus {
  /** The origin when the tab shows an http(s) page. */
  origin: string | null;
  projectId: number | null;
  /** Lens may read this origin (the person granted it). */
  permitted: boolean;
  /** Null when Lens is not collecting on this tab. */
  mode: CaptureMode | null;
}

/** Background → every extension page. */
export type Broadcast = { kind: 'captured'; capture: Capture } | { kind: 'tabChanged'; tabId: number };

export function send<T>(request: BackgroundRequest): Promise<T> {
  return browser.runtime.sendMessage(request) as Promise<T>;
}

export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
