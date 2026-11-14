import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { BLOCK_SELECTOR, scrubRecording } from '@/collector/recording';

/** A full DOM checkpoint this often; the recorder keeps the current and the previous segment. */
const CHECKOUT_MS = 30_000;
/** Beyond this the oldest segment goes first, so a busy page cannot exhaust memory. */
const MAX_EVENTS = 20_000;

export type RecorderRequest = { kind: 'lens-recording' };

// Injected by the background only into tabs Lens collects on (registration: 'runtime').
export default defineContentScript({
  registration: 'runtime',
  main() {
    const scope = globalThis as typeof globalThis & { __lensRecorder?: boolean };
    if (scope.__lensRecorder) return;
    scope.__lensRecorder = true;

    let previous: eventWithTime[] = [];
    let current: eventWithTime[] = [];
    record({
      emit(event, isCheckout) {
        scrubRecording(event);
        if (isCheckout) {
          previous = current;
          current = [];
        }
        current.push(event);
        if (previous.length + current.length > MAX_EVENTS) previous = [];
      },
      checkoutEveryNms: CHECKOUT_MS,
      // Typed values and editable text never leave the page. Hidden inputs, token meta tags and
      // marked elements are not recorded at all.
      maskAllInputs: true,
      maskTextSelector: '[contenteditable], [contenteditable] *',
      blockSelector: BLOCK_SELECTOR,
      recordCanvas: false,
      collectFonts: false,
    });

    browser.runtime.onMessage.addListener((message: RecorderRequest, _sender, reply) => {
      if (message?.kind !== 'lens-recording') return;
      reply([...previous, ...current]);
    });
  },
});
