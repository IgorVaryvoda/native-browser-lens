import { describe, expect, it } from 'vitest';
import { BLOCK_SELECTOR, scrubRecording } from './recording';
import { redactContent, REDACTED } from './sanitize';

describe('redactContent', () => {
  it('stays linear on long runs of word characters', () => {
    const long = 'a'.repeat(300_000);
    const started = performance.now();
    redactContent(`${long} ${long}token ${long}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('removes signed-URL keys inside CSS and srcset', () => {
    const css = 'background:url(https://cdn.test/a.png?X-Amz-Signature=abc123&w=2)';
    const srcset = '/b.png?sig=zz9 1x, /b2.png?code=oauth77 2x';
    expect(redactContent(css)).not.toContain('abc123');
    expect(redactContent(css)).toContain('w=2');
    expect(redactContent(srcset)).not.toMatch(/zz9|oauth77/);
  });
});

describe('scrubRecording', () => {
  it('redacts sensitive meta content, URL attributes and keyed values', () => {
    const event = {
      type: 2,
      data: {
        node: {
          childNodes: [
            { type: 2, tagName: 'meta', attributes: { property: 'og:session', content: 's-111' } },
            { type: 2, tagName: 'a', attributes: { href: 'https://shop.test/next?access_token=t-222' } },
            { type: 2, tagName: 'div', attributes: { 'data-api-key': 'k-333' } },
          ],
        },
      },
    };
    const text = JSON.stringify(scrubRecording(event));
    expect(text).not.toMatch(/s-111|t-222|k-333/);
    expect(text).toContain(REDACTED);
  });

  it('blocks credential-like meta tags by name, property and http-equiv', () => {
    expect(BLOCK_SELECTOR).toContain('meta[property*=session i]');
    expect(BLOCK_SELECTOR).toContain('meta[http-equiv*=csrf i]');
  });
});
