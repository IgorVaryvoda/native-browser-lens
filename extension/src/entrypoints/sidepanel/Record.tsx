import { useEffect, useRef, useState } from 'react';
import type { LensClient } from '@/lens-client';
import { send, type CaptureResult, type SessionStart, type TabStatus } from '@/messages';
import { MicIcon, StopIcon } from '@/ui/icons';
import { MicrophoneBlocked, record, type Recording } from '@/voice';

export type PanelMode = 'record' | 'capture';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A setting kept in the browser profile; it never matters enough to fail over. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    void browser.storage.local
      .get(key)
      .then((found) => found[key] !== undefined && setValue(found[key] as T))
      .catch(() => {});
  }, [key]);
  return [value, (next: T) => (setValue(next), void browser.storage.local.set({ [key]: next }).catch(() => {}))];
}

/**
 * Record mode: Record starts a session in this tab (and the microphone, when chosen); Stop saves
 * everything since as one recording and opens it for review.
 */
export function RecordControls({
  client,
  tabId,
  site,
  onProblem,
}: {
  client: LensClient;
  tabId: number | null;
  site: TabStatus | null;
  onProblem: (message: string | null) => void;
}) {
  const [voice, setVoice] = useStored('lens.voice', true);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const microphone = useRef<Recording | null>(null);
  const running = site?.session ?? null;

  useEffect(() => {
    if (running === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [running]);

  // Firefox only: closing the panel ends its microphone; the session keeps running in the tab.
  // Chrome records the voice in the background, so it survives the panel.
  useEffect(() => () => microphone.current?.cancel(), []);
  const inBackground = !import.meta.env.FIREFOX;

  async function start() {
    if (tabId === null) return;
    onProblem(null);
    if (voice && !inBackground) {
      try {
        microphone.current = await record();
      } catch (error) {
        if (error instanceof MicrophoneBlocked) {
          await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
          return onProblem('Allow the microphone in the tab that opened, then press Record again.');
        }
        return onProblem(`The microphone did not start: ${(error as Error).message}`);
      }
    }
    const started = await send<SessionStart>({ kind: 'startSession', tabId, voice: voice && inBackground });
    if (!started.ok) {
      microphone.current?.cancel();
      microphone.current = null;
      if (started.microphoneBlocked) {
        await browser.tabs.create({ url: browser.runtime.getURL('/microphone.html') });
        return onProblem('Allow the microphone in the tab that opened, then press Record again.');
      }
      return onProblem(started.error);
    }
    setNow(Date.now());
  }

  async function stop() {
    if (tabId === null) return;
    setBusy(true);
    const spoken = microphone.current;
    microphone.current = null;
    try {
      const [result, wav] = await Promise.all([
        send<CaptureResult>({ kind: 'stopSession', tabId }),
        spoken ? spoken.stop() : Promise.resolve(null),
      ]);
      if (!result.ok) return onProblem(`The recording was not saved: ${result.error}`);
      if (wav && spoken) {
        const audio = await client.upload(wav, 'audio/wav');
        await client.request({
          method: 'addVoiceNote',
          params: { observation: result.capture.observation, startedAt: spoken.startedAt, audio },
        });
      }
      onProblem(null);
      await browser.tabs.create({
        url: browser.runtime.getURL(`/review.html?observation=${result.capture.observation}`),
      });
    } catch (error) {
      onProblem(`The recording was not saved: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (running !== null) {
    return (
      <div className="record-live" role="status" aria-label="Recording">
        <span className="rec-dot" aria-hidden="true" />
        <span className="record-time num">{clock(now - running)}</span>
        <span className="small muted record-what">
          {microphone.current || site?.voice ? 'Screen, steps and your voice' : 'Screen and steps'}
        </span>
        <button type="button" className="btn btn-danger" onClick={() => void stop()} disabled={busy}>
          <StopIcon />
          {busy ? 'Saving…' : 'Stop'}
        </button>
      </div>
    );
  }
  return (
    <div className="record-start">
      <label className="check">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        <span>
          <MicIcon size={14} /> Record my voice
        </span>
      </label>
      <button
        type="button"
        className="btn btn-primary btn-lg btn-block"
        onClick={() => void start()}
        disabled={!site?.mode || busy}
      >
        <span className="rec-dot rec-dot-still" aria-hidden="true" />
        Record
      </button>
    </div>
  );
}
