import { describe, expect, it } from 'vitest';
import { isNoise } from './noise';

describe('isNoise', () => {
  it('drops analytics, beacons and inline data', () => {
    expect(isNoise('https://studio.test/api/phr/e/?ip=0&_=1763120400&ver=1.200.0')).toBe(true);
    expect(isNoise('https://studio.test/ingest/batch/', 'Fetch', '{"api_key":"phc_abc","batch":[]}')).toBe(true);
    expect(isNoise('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(isNoise('https://us.i.posthog.com/decide/')).toBe(true);
    expect(isNoise('https://studio.test/_vercel/insights/view')).toBe(true);
    expect(isNoise('https://studio.test/anything', 'Ping')).toBe(true);
    expect(isNoise('data:image/png;base64,AAAA')).toBe(true);
    expect(isNoise('blob:https://studio.test/1234')).toBe(true);
  });

  it('keeps the app own requests', () => {
    expect(isNoise('https://studio.test/api/assets/42/comments', 'Fetch', '{"text":"hi"}')).toBe(false);
    expect(isNoise('https://studio.test/api/price', 'XHR')).toBe(false);
    expect(isNoise('https://studio.test/collections?ver=2')).toBe(false);
  });
});
