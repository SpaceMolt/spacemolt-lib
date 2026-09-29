import { expect, test } from 'bun:test';
import { jitteredDelayMs } from '../src/jitter.ts';

// Direct unit test for jitteredDelayMs: nothing else in the suite exercises
// its formula directly (only indirectly, through retry paths whose actual
// delayMs is inherently randomized), so a mutation to its body (e.g.
// `return baseMs`) would otherwise leave the suite green.

test('jitteredDelayMs spans [base, base + max(0.25*base, 250)) for a small base', () => {
  const base = 250; // 0.25 * base = 62.5, floor wins -> max jitter is 250
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    expect(jitteredDelayMs(base)).toBe(base);

    Math.random = () => 0.999;
    const upper = jitteredDelayMs(base);
    expect(upper).toBeGreaterThan(base);
    expect(upper).toBeLessThan(base + 250);
  } finally {
    Math.random = originalRandom;
  }
});

test('jitteredDelayMs spans [base, base + 0.25*base) for a large base', () => {
  const base = 4000; // 0.25 * base = 1000 > 250 floor
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    expect(jitteredDelayMs(base)).toBe(base);

    Math.random = () => 0.999;
    const upper = jitteredDelayMs(base);
    expect(upper).toBeGreaterThan(base);
    expect(upper).toBeLessThan(base + 1000);
  } finally {
    Math.random = originalRandom;
  }
});
