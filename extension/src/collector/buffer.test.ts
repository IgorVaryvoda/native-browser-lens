import { describe, expect, it } from 'vitest';
import { EvidenceBuffer, MAX_EVENTS, WINDOW_MS } from './buffer';

describe('EvidenceBuffer', () => {
  it('keeps two minutes, then evicts by count and records the gap', () => {
    let now = 0;
    const buffer = new EvidenceBuffer(() => now);
    buffer.start(1, 'deep');
    buffer.record(1, 'console', { text: 'old' });
    now = WINDOW_MS + 1;
    for (let i = 0; i < MAX_EVENTS + 5; i++) buffer.record(1, 'console', { text: `n${i}` });
    const snapshot = buffer.snapshot(1)!;
    expect(snapshot.events).toHaveLength(MAX_EVENTS);
    expect(JSON.stringify(snapshot.events)).not.toContain('"old"');
    expect(snapshot.gaps.map((g) => g.channel)).toContain('buffer');
  });

  it('replaces an oversized event with an omission and ignores tabs it does not collect', () => {
    const buffer = new EvidenceBuffer(() => 1);
    buffer.start(1, 'limited');
    buffer.record(1, 'responseBody', { body: Array.from({ length: 60 }, () => 'x'.repeat(1000)) });
    buffer.record(2, 'console', { text: 'not collected' });
    expect(buffer.snapshot(1)!.events[0]!.data).toHaveProperty('omission');
    expect(buffer.snapshot(2)).toBeUndefined();
  });
});
