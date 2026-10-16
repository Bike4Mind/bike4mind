import { describe, expect, it } from 'vitest';
import {
  classifyProviderFailure,
  describeProviderFailure,
  formatFailureDuration,
  toCompletionErrorCause,
} from './providerFailure';

const withCode = (message: string, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code }, extra);

/** The shape undici throws when the upstream socket closes mid-body. */
function undiciTerminated(): TypeError {
  const socketError = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
  return new TypeError('terminated', { cause: socketError });
}

describe('classifyProviderFailure', () => {
  it('reads the nested undici socket error under TypeError: terminated as a lost connection', () => {
    const failure = classifyProviderFailure(undiciTerminated());
    expect(failure).toMatchObject({ kind: 'connection_lost', transportCode: 'UND_ERR_SOCKET' });
    expect(failure.chain).toEqual([
      { name: 'TypeError', message: 'terminated' },
      { name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'other side closed' },
    ]);
  });

  it('still calls a bare terminated a lost connection, with no code to report', () => {
    const failure = classifyProviderFailure(new TypeError('terminated'));
    expect(failure.kind).toBe('connection_lost');
    expect(failure.transportCode).toBeUndefined();
  });

  it('follows a cause chain wrapped by a provider SDK', () => {
    const wrapped = Object.assign(new Error('Connection error.'), {
      name: 'APIConnectionError',
      cause: undiciTerminated(),
    });
    expect(classifyProviderFailure(wrapped)).toMatchObject({
      kind: 'connection_lost',
      transportCode: 'UND_ERR_SOCKET',
    });
  });

  it.each([
    ['ECONNRESET', 'connection_lost'],
    ['EPIPE', 'connection_lost'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'unreachable'],
    ['EAI_AGAIN', 'unreachable'],
    ['ECONNREFUSED', 'unreachable'],
  ])('maps %s to %s', (code, kind) => {
    const error = new TypeError('fetch failed', { cause: withCode(`connect ${code}`, code) });
    expect(classifyProviderFailure(error)).toMatchObject({ kind, transportCode: code });
  });

  it("looks inside an AggregateError's errors, where connect failures to several addresses land", () => {
    const aggregate = new AggregateError([withCode('connect ECONNREFUSED 10.0.0.1:443', 'ECONNREFUSED')], '');
    expect(classifyProviderFailure(new TypeError('fetch failed', { cause: aggregate }))).toMatchObject({
      kind: 'unreachable',
      transportCode: 'ECONNREFUSED',
    });
  });

  it.each([
    ['axios', { isAxiosError: true, response: { status: 503 } }, 503],
    ['aws sdk', { $metadata: { httpStatusCode: 429, attempts: 6 } }, 429],
    ['provider sdk', { status: 500 }, 500],
  ])('reads an %s HTTP status as an upstream error', (_name, shape, status) => {
    const failure = classifyProviderFailure(Object.assign(new Error('raw upstream body'), shape));
    expect(failure).toMatchObject({ kind: 'upstream_error', upstreamStatus: status });
  });

  it('reports the AWS SDK attempt count', () => {
    const error = Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429, attempts: 6 } });
    expect(classifyProviderFailure(error).sdkAttempts).toBe(6);
  });

  it('prefers an HTTP status over a transport code: a response did come back', () => {
    const error = Object.assign(new Error('bad gateway'), { status: 502, cause: withCode('reset', 'ECONNRESET') });
    expect(classifyProviderFailure(error)).toMatchObject({ kind: 'upstream_error', upstreamStatus: 502 });
  });

  it.each([
    [Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' })],
    [Object.assign(new Error('socket timed out'), { name: 'TimeoutError' })],
    [new Error('Anthropic API stream timeout - no response received within 90 seconds.')],
  ])('reads a timeout with no code: %s', error => {
    expect(classifyProviderFailure(error).kind).toBe('timeout');
  });

  it('keeps a client disconnect distinct from the transport failure it caused', () => {
    expect(classifyProviderFailure(undiciTerminated(), { clientAborted: true }).kind).toBe('client_aborted');
  });

  it('leaves an unrecognised error unclassified', () => {
    expect(classifyProviderFailure(new Error('something odd')).kind).toBeUndefined();
  });

  it('survives a cycle in the cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(classifyProviderFailure(a).chain).toHaveLength(2);
  });

  it('ignores a code outside the allowlist, so it never reaches the wire', () => {
    const failure = classifyProviderFailure(withCode('weird', 'ERR_SOMETHING_SECRET'));
    expect(failure.transportCode).toBeUndefined();
    expect(toCompletionErrorCause(failure)).toBeUndefined();
  });
});

describe('formatFailureDuration', () => {
  it.each([
    [850, '850ms'],
    [45_000, '45s'],
    [649_000, '10m 49s'],
    [3_780_000, '1h 3m'],
  ])('formats %d as %s', (ms, text) => {
    expect(formatFailureDuration(ms)).toBe(text);
  });
});

describe('describeProviderFailure', () => {
  it('names a lost connection with how long it ran and how long it was silent', () => {
    expect(describeProviderFailure({ kind: 'connection_lost', elapsedMs: 649_000, idleMs: 649_000 })).toBe(
      'Lost the connection to the model provider after 10m 49s (no data for 10m 49s)'
    );
  });

  it('leaves out a silence too short to mean anything', () => {
    expect(describeProviderFailure({ kind: 'timeout', elapsedMs: 120_000, idleMs: 200 })).toBe(
      'The model provider timed out after 2m 0s'
    );
  });

  it('names an unreachable provider', () => {
    expect(describeProviderFailure({ kind: 'unreachable', transportCode: 'ENOTFOUND' })).toBe(
      'Could not reach the model provider'
    );
  });

  // ServerLlmBackend.errorFrameToModelCallError reads the status back out of this suffix.
  it('keeps the (upstream NNN) suffix verbatim for an upstream status', () => {
    expect(describeProviderFailure({ kind: 'upstream_error', upstreamStatus: 503 })).toBe(
      'Model provider returned an error (upstream 503)'
    );
  });

  it('falls back to the generic message with nothing classified', () => {
    expect(describeProviderFailure(undefined)).toBe('Model provider returned an error');
  });
});

describe('toCompletionErrorCause', () => {
  it('keeps only the classification, safe code and whole-ms timing', () => {
    const cause = toCompletionErrorCause(classifyProviderFailure(undiciTerminated()), {
      elapsedMs: 649_000.4,
      idleMs: 648_999.6,
    });
    expect(cause).toEqual({
      kind: 'connection_lost',
      transportCode: 'UND_ERR_SOCKET',
      elapsedMs: 649_000,
      idleMs: 649_000,
    });
  });

  it('sends nothing for a client that has gone', () => {
    expect(
      toCompletionErrorCause(classifyProviderFailure(undiciTerminated(), { clientAborted: true }))
    ).toBeUndefined();
  });
});
