import { record } from '@rrweb/record';
import type { eventWithTime } from '@rrweb/types';
import { REDACTED, SENSITIVE, redactContent, sanitizeUrl } from '@/collector/sanitize';

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
        scrub(event);
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
      blockSelector: [
        '[data-lens-block]',
        'input[type=hidden]',
        'meta[name*=csrf i]',
        'meta[name*=token i]',
        'meta[name*=nonce i]',
      ].join(', '),
      recordCanvas: false,
      collectFonts: false,
    });

    /** The evidence's redaction rules, in place, without cutting long strings: the DOM must stay whole. */
    function scrub(value: unknown): unknown {
      if (typeof value === 'string') return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : redactContent(value);
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = scrub(value[i]);
      } else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) record[key] = SENSITIVE.test(key) ? REDACTED : scrub(record[key]);
      }
      return value;
    }

    browser.runtime.onMessage.addListener((message: RecorderRequest, _sender, reply) => {
      if (message?.kind !== 'lens-recording') return;
      reply([...previous, ...current]);
    });
  },
});
