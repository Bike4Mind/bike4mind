import { describe, it, expect, afterAll } from 'vitest';
import { Client, Connection, errors } from '@opensearch-project/opensearch';
import { Readable } from 'node:stream';
import { isTransientOpenSearchError } from './opensearchClient';

// Higher-fidelity companion to opensearchClient.test.ts. Instead of fabricating error
// objects, this drives a REAL opensearch-js Client+Transport through a fake Connection so
// the errors `isTransientOpenSearchError` sees are the genuine ResponseError /
// ConnectionError / TimeoutError instances opensearch-js 2.11 actually throws. This guards
// against the predicate silently drifting from the real error shapes (statusCode location,
// error `name`s, etc.).

type Behavior = { kind: 'status'; statusCode: number; body?: unknown } | { kind: 'error'; error: Error };

// What FakeConnection should do on the next request (Client instantiates the connection
// itself, so behavior is injected via this module-level variable rather than the ctor).
let nextBehavior: Behavior = { kind: 'status', statusCode: 200, body: {} };

/** Build a fake http.IncomingMessage-like stream the Transport reads the response body from. */
function makeResponse(statusCode: number, body: unknown): Readable {
  const json = JSON.stringify(body ?? {});
  const stream = new Readable({ read() {} }) as Readable & { statusCode: number; headers: Record<string, string> };
  stream.statusCode = statusCode;
  stream.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(json)),
  };
  // Push after the Transport has attached its data/end listeners.
  setImmediate(() => {
    stream.push(json);
    stream.push(null);
  });
  return stream;
}

// Mirrors the real Connection.request contract: call back with a response (Transport turns
// a >=400 status into a real ResponseError) or with a real error instance.
class FakeConnection extends Connection {
  request(_params: unknown, callback: (err: Error | null, response: Readable | null) => void) {
    const behavior = nextBehavior;
    setImmediate(() => {
      if (behavior.kind === 'error') {
        callback(behavior.error, null);
      } else {
        callback(null, makeResponse(behavior.statusCode, behavior.body));
      }
    });
    return { abort: () => {} } as never;
  }
}

const client = new Client({ node: 'http://localhost:9200', Connection: FakeConnection, maxRetries: 0 });

afterAll(async () => {
  await client.close();
});

/** Issue a request through the real Transport and return the error it throws. */
async function errorFor(behavior: Behavior): Promise<Error> {
  nextBehavior = behavior;
  try {
    await client.index({ index: 'idx', id: '1', body: { field: 'value' } });
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the request to throw');
}

describe('isTransientOpenSearchError against real opensearch-js errors', () => {
  it.each([429, 502, 503, 504])('classifies a real %i ResponseError as transient', async statusCode => {
    const err = await errorFor({
      kind: 'status',
      statusCode,
      body: { error: { type: 'circuit_breaking_exception' }, status: statusCode },
    });
    expect(err).toBeInstanceOf(errors.ResponseError);
    expect((err as errors.ResponseError).statusCode).toBe(statusCode);
    expect(isTransientOpenSearchError(err)).toBe(true);
  });

  it.each([400, 404, 409])('classifies a real %i ResponseError as non-transient', async statusCode => {
    const err = await errorFor({
      kind: 'status',
      statusCode,
      body: { error: { type: 'mapper_parsing_exception' }, status: statusCode },
    });
    expect(err).toBeInstanceOf(errors.ResponseError);
    expect(isTransientOpenSearchError(err)).toBe(false);
  });

  it('classifies a real ConnectionError as transient', async () => {
    const err = await errorFor({ kind: 'error', error: new errors.ConnectionError('socket hang up') });
    expect(err).toBeInstanceOf(errors.ConnectionError);
    expect(isTransientOpenSearchError(err)).toBe(true);
  });

  it('classifies a real TimeoutError as transient', async () => {
    const err = await errorFor({ kind: 'error', error: new errors.TimeoutError('Request timed out', {} as never) });
    expect(err).toBeInstanceOf(errors.TimeoutError);
    expect(isTransientOpenSearchError(err)).toBe(true);
  });

  it('does not retry a real RequestAbortedError', async () => {
    const err = await errorFor({ kind: 'error', error: new errors.RequestAbortedError('Request aborted') });
    expect(err).toBeInstanceOf(errors.RequestAbortedError);
    expect(isTransientOpenSearchError(err)).toBe(false);
  });
});
