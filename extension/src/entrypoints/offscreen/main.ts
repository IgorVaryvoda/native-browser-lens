// Chrome: the microphone of a Record mode session lives here, not in the side panel, so closing
// the panel does not end it. The background starts and stops it; nothing else talks to this page.
import type { OffscreenRequest, OffscreenReply } from '@/messages';
import { MicrophoneBlocked, record, type Recording } from '@/voice';

let current: Recording | null = null;

browser.runtime.onMessage.addListener((message: OffscreenRequest, _sender, reply) => {
  if (message?.target !== 'offscreen') return;
  handle(message).then(reply, (error: Error) => reply({ ok: false, error: error.message } satisfies OffscreenReply));
  return true;
});

async function handle(message: OffscreenRequest): Promise<OffscreenReply> {
  switch (message.kind) {
    case 'mic-start':
      current?.cancel();
      current = null;
      try {
        current = await record();
        return { ok: true, startedAt: current.startedAt };
      } catch (error) {
        return { ok: false, error: (error as Error).message, blocked: error instanceof MicrophoneBlocked };
      }
    case 'mic-stop': {
      const spoken = current;
      current = null;
      if (!spoken) return { ok: false, error: 'No microphone runs.' };
      const wav = new Uint8Array(await (await spoken.stop()).arrayBuffer());
      // Extension messages carry JSON only.
      let binary = '';
      for (let i = 0; i < wav.length; i += 0x8000) binary += String.fromCharCode(...wav.subarray(i, i + 0x8000));
      return { ok: true, startedAt: spoken.startedAt, wav: btoa(binary) };
    }
    case 'mic-cancel':
      current?.cancel();
      current = null;
      return { ok: true, startedAt: 0 };
  }
}
