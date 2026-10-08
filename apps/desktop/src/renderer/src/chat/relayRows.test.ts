import { describe, expect, it } from 'vitest';
import { automaticSummary, displayText, relaySummary } from './relayRows';

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

  it('summarises the user-facing wording, not the model-facing one', () => {
    const summary = relaySummary({
      content: 'The session you started, "T4" (e8d8981c-5829-4e70-a20a-8e82370ac565), has finished.',
      display: 'The session "T4" has finished.',
      relay: from,
    });
    expect(summary).toBe('Received message from T25: The session "T4" has finished.');
  });
});

describe('displayText', () => {
  it('prefers the user-facing wording when there is one', () => {
    expect(displayText({ content: 'read it with session_read (abc)', display: 'It has finished.' })).toBe(
      'It has finished.'
    );
  });

  // Messages stored before `display` existed have only the model's copy. Showing it is worse
  // than showing the new wording and far better than an empty row.
  it('falls back to the stored content when no wording was recorded', () => {
    expect(displayText({ content: 'an older report' })).toBe('an older report');
    expect(displayText({ content: 'an older report', display: '   ' })).toBe('an older report');
  });
});

describe('automaticSummary', () => {
  it('names auto-fix before what the turn is about', () => {
    const automatic = {
      kind: 'auto-fix' as const,
      prUrl: 'https://github.com/example-org/widgets/pull/611',
      prNumber: 611,
      summary: '1 failing check on #611',
    };
    expect(automaticSummary({ automatic })).toBe('Started by auto-fix: 1 failing check on #611');
  });
});
