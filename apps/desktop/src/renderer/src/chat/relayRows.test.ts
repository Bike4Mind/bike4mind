import { describe, expect, it } from 'vitest';
import { relaySummary } from './relayRows';

const from = { fromSessionId: 'abc', fromTitle: 'T25', hops: 1 };

describe('relaySummary', () => {
  it('names the sender before the message', () => {
    expect(relaySummary({ content: 'render replies as markdown', relay: from })).toBe(
      'Received message from T25: render replies as markdown'
    );
  });

  it('flattens a multi-line message into the one line the row has', () => {
    expect(relaySummary({ content: 'first line\n\nsecond line', relay: from })).toBe(
      'Received message from T25: first line second line'
    );
  });

  it('clips a long message rather than letting it push the chevron off the row', () => {
    const summary = relaySummary({ content: 'x'.repeat(200), relay: from });
    expect(summary).toBe(`Received message from T25: ${'x'.repeat(61)}...`);
  });

  // The sender is still named when the descriptor is missing: a row that says only "Received
  // message" would be indistinguishable from the user's own turn at a glance.
  it('falls back to naming an unknown sender rather than dropping the prefix', () => {
    expect(relaySummary({ content: 'hello' })).toBe('Received message from another session: hello');
  });

  it('is just the header when the message is empty', () => {
    expect(relaySummary({ content: '   ', relay: from })).toBe('Received message from T25');
  });
});
