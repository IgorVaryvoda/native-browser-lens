import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { ActionRecorder, elementMap } from '@/collector/actions';
import { BLOCK_SELECTOR, scrubRecording } from '@/collector/recording';
import type { Action } from '@/protocol/Action';
import type { PageElement } from '@/protocol/PageElement';

/** A full DOM checkpoint this often; the recorder keeps the current and the previous segment. */
const CHECKOUT_MS = 30_000;
/** Beyond this the oldest segment goes first, so a busy page cannot exhaust memory. */
const MAX_EVENTS = 20_000;
/** Elements named for marks; the daemon keeps at most 800. */
const MAX_ELEMENTS = 800;

export type RecorderRequest = { kind: 'lens-prepare' };
/** What the page holds for a capture: the DOM recording, steps not reported yet, and what is on screen. */
export interface Prepared {
  recording: eventWithTime[];
  pending: Action[];
  elements: PageElement[];
}
export type RecorderMessage = { kind: 'lens-action'; action: Action };

// Injected by the background only into tabs Lens collects on (registration: 'runtime').
export default defineContentScript({
  registration: 'runtime',
  main() {
    const scope = globalThis as typeof globalThis & { __lensRecorder?: boolean };
    if (scope.__lensRecorder) return;
    scope.__lensRecorder = true;

    let previous: eventWithTime[] = [];
    let current: eventWithTime[] = [];
    const stopRecording = record({
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

    // Steps go to the background as they happen, so they outlive this document.
    let collecting: Action[] | null = null;
    const steps = new ActionRecorder(document, (action) => {
      if (collecting) return void collecting.push(action);
      // After the extension reloads or updates, this script stays in the page without an
      // extension: sending then throws at once. It stops itself instead of failing on each click.
      try {
        if (!browser.runtime?.id) return retire();
        void browser.runtime.sendMessage({ kind: 'lens-action', action } satisfies RecorderMessage).catch(() => {});
      } catch {
        retire();
      }
    });
    steps.start();
    function retire() {
      steps.stop();
      stopRecording?.();
      previous = [];
      current = [];
    }

    browser.runtime.onMessage.addListener((message: RecorderRequest, _sender, reply) => {
      if (message?.kind !== 'lens-prepare') return;
      collecting = [];
      steps.flushAll();
      const pending = collecting;
      collecting = null;
      reply({ recording: [...previous, ...current], pending, elements: elementMap(document, MAX_ELEMENTS) } satisfies Prepared);
    });
  },
});
