import { describe, expect, it } from 'vitest';
import { bodyEvidence, REDACTED, sanitize, sanitizeText, sanitizeUrl } from './sanitize';

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

describe('sanitizeUrl', () => {
  it('removes credentials, fragments and secret query values', () => {
    const clean = sanitizeUrl(`https://user:pass@shop.test/cart?access_token=abc&page=2&X-Amz-Signature=f00#t=${jwt}`);
    expect(clean).not.toMatch(/user|pass@|abc|f00|eyJ/);
    expect(clean).toContain('page=2');
  });

  it('catches tokens by their shape in any value and in the path', () => {
    expect(sanitizeUrl(`https://shop.test/reset/${jwt}?next=${jwt}`)).not.toContain('eyJ');
    expect(sanitizeUrl('https://api.test/v1?q=sk-abcdefghijklmnopqrstu')).not.toContain('sk-abcdef');
  });

  it('caps the length', () => {
    expect(sanitizeUrl(`https://shop.test/?q=${'a'.repeat(40_000)}`).length).toBeLessThanOrEqual(16 * 1024);
  });
});

describe('sanitize', () => {
  it('redacts by key, by header name and by content', () => {
    const clean = sanitize({
      password: 'hunter2',
      headers: [{ name: 'Authorization', value: 'Bearer abc.def' }, { name: 'Accept', value: 'text/html' }],
      note: `token=xyz ${jwt}`,
    });
    const text = JSON.stringify(clean);
    expect(text).not.toMatch(/hunter2|abc\.def|xyz|eyJ/);
    expect(text).toContain('text/html');
  });

  it('keeps ordinary text', () => {
    expect(sanitizeText('total is NaN')).toBe('total is NaN');
  });
});

describe('bodyEvidence', () => {
  it('keeps same-origin JSON bodies without their secrets', () => {
    const evidence = bodyEvidence('{"error":"NaN","token":"s3cret"}', 'application/json', 'https://a.test/api', 'https://a.test/');
    expect(evidence).toEqual({ format: 'json', body: { error: 'NaN', token: REDACTED } });
  });

  it('leaves out other origins and binary bodies', () => {
    expect(bodyEvidence('{}', 'application/json', 'https://cdn.test/x', 'https://a.test/')).toHaveProperty('omission');
    expect(bodyEvidence('xx', 'image/png', 'https://a.test/x', 'https://a.test/')).toHaveProperty('omission');
  });
});
