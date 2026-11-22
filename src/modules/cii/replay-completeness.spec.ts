import { describe, expect, it } from 'vitest';

import { isReplayComplete } from './replay-completeness.js';

const windowStart = new Date('2026-11-20T00:00:00Z');
const end = { seq: 120, storedAt: new Date('2026-11-21T00:00:00Z') };

describe('isReplayComplete', () => {
  it('has nothing to read when the subject had no message in the window', () => {
    const progress = { passedWindow: false, lastSequence: undefined };
    expect(isReplayComplete(undefined, windowStart, progress)).toBe(true);
    expect(
      isReplayComplete(
        { seq: 7, storedAt: new Date('2026-11-19T23:59:59Z') },
        windowStart,
        progress,
      ),
    ).toBe(true);
  });

  it('is complete when the replay read through the last message at start', () => {
    expect(
      isReplayComplete(end, windowStart, {
        passedWindow: false,
        lastSequence: 120,
      }),
    ).toBe(true);
    expect(
      isReplayComplete(end, windowStart, {
        passedWindow: false,
        lastSequence: 180,
      }),
    ).toBe(true);
  });

  it('is complete when the handler stopped after the window', () => {
    expect(
      isReplayComplete(end, windowStart, {
        passedWindow: true,
        lastSequence: 60,
      }),
    ).toBe(true);
  });

  it('is incomplete when the replay stopped early (cancelled, iterator closed) or read nothing', () => {
    expect(
      isReplayComplete(end, windowStart, {
        passedWindow: false,
        lastSequence: 119,
      }),
    ).toBe(false);
    expect(
      isReplayComplete(end, windowStart, {
        passedWindow: false,
        lastSequence: undefined,
      }),
    ).toBe(false);
  });
});
