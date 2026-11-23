import { describe, expect, it } from 'vitest';

import { addVary, type HeaderReply } from './csv.js';

/** A reply that keeps its headers by lower-case name, like Fastify's. */
function replyWith(vary?: string | string[]): HeaderReply & {
  readonly vary: () => unknown;
} {
  const headers = new Map<string, string | string[]>();
  if (vary !== undefined) headers.set('vary', vary);
  return {
    getHeader: (name) => headers.get(name.toLowerCase()),
    header: (name, value) => headers.set(name.toLowerCase(), value),
    vary: () => headers.get('vary'),
  };
}

describe('addVary', () => {
  // The CORS hook sets `Vary: Origin` before the handler; `@Header('vary',
  // 'accept')` replaced it, so cross-origin responses that echo an allowed
  // origin no longer varied on Origin.
  it('keeps the Vary: Origin of the CORS hook and adds the field once', () => {
    const reply = replyWith('Origin');
    addVary(reply, 'Accept');
    expect(reply.vary()).toBe('Origin, Accept');
    addVary(reply, 'accept');
    expect(reply.vary()).toBe('Origin, Accept');
  });

  it('sets the header when none is there', () => {
    const reply = replyWith();
    addVary(reply, 'Accept');
    expect(reply.vary()).toBe('Accept');
  });

  it('joins repeated values and keeps *', () => {
    const repeated = replyWith(['Origin', 'Accept-Encoding']);
    addVary(repeated, 'Accept');
    expect(repeated.vary()).toBe('Origin, Accept-Encoding, Accept');
    const any = replyWith('*');
    addVary(any, 'Accept');
    expect(any.vary()).toBe('*');
  });
});
