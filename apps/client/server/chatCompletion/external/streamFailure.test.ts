import { describe, expect, it } from 'vitest';
import { classifyStreamFailure, createStreamStats, streamFailureLogFields } from './streamFailure';

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const terminated = () =>
  new TypeError('terminated', {
    cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }),
  });

describe('createStreamStats', () => {
  it('measures a stream that never sent anything from the provider call, not the request', () => {
    const c = clock();
    const stats = createStreamStats(c.now);
    c.advance(300);
    stats.completionStarted();
    c.advance(649_000);
    expect(stats.snapshot()).toEqual({
      elapsedMs: 649_300,
      idleMs: 649_000,
      chunks: 0,
      chars: 0,
      visibleTextSent: false,
    });
  });

  it('times the first chunk and the silence since the last one', () => {
    const c = clock();
    const stats = createStreamStats(c.now);
    stats.completionStarted();
    c.advance(2_000);
    stats.chunk(['thinking'], { channel: 'reasoning' });
    c.advance(1_000);
    stats.chunk([undefined, 'Hi']);
    c.advance(30_000);
    expect(stats.snapshot()).toEqual({
      elapsedMs: 33_000,
      timeToFirstChunkMs: 2_000,
      idleMs: 30_000,
      chunks: 2,
      chars: 10,
      visibleTextSent: true,
    });
  });

  it('does not count reasoning as a visible token', () => {
    const stats = createStreamStats();
    stats.completionStarted();
    stats.chunk(['hmm'], { channel: 'reasoning' });
    stats.chunk([], { outputTokens: 3 });
    expect(stats.snapshot().visibleTextSent).toBe(false);
  });
});

describe('classifyStreamFailure', () => {
  it('puts the stream timing on the wire cause', () => {
    const c = clock();
    const stats = createStreamStats(c.now);
    stats.completionStarted();
    c.advance(649_000);
    expect(classifyStreamFailure(terminated(), stats, { clientAborted: false }).cause).toEqual({
      kind: 'connection_lost',
      transportCode: 'UND_ERR_SOCKET',
      elapsedMs: 649_000,
      idleMs: 649_000,
    });
  });

  it('keeps a client disconnect out of the wire cause and names it in the log', () => {
    const failure = classifyStreamFailure(terminated(), createStreamStats(), { clientAborted: true });
    expect(failure.cause).toBeUndefined();
    const fields = streamFailureLogFields(failure, 'gpt-x', { requests: 1, attempts: 1 });
    expect(fields).toMatchObject({ failureKind: 'client_aborted', model: 'gpt-x', providerRequests: 1, attempt: 1 });
  });

  it('logs an unclassified failure as such rather than dropping the field', () => {
    const failure = classifyStreamFailure(new Error('odd'), createStreamStats(), { clientAborted: false });
    expect(streamFailureLogFields(failure, 'm', { requests: 0, attempts: 0 }).failureKind).toBe('unclassified');
  });

  it("prefers the AWS SDK's own attempt count, which counts the retries it ran itself", () => {
    const error = Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429, attempts: 6 } });
    const failure = classifyStreamFailure(error, createStreamStats(), { clientAborted: false });
    expect(streamFailureLogFields(failure, 'm', { provider: 'bedrock', requests: 1, attempts: 1 }).attempt).toBe(6);
  });
});
