import { describe, expect, it } from 'vitest';
import { PullIdleTimeoutError } from '../errors';
import { describeFailure, errorCode } from './failure';
import { ServerRedirectError, ServerTransportError } from './serverFetch';

const coded = (code: string) => new TypeError('fetch failed', { cause: { code } });

describe('errorCode', () => {
  it('reads the code on the error, then on its cause', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
    expect(errorCode(coded('ENOTFOUND'))).toBe('ENOTFOUND');
    expect(errorCode(new Error('x'))).toBeUndefined();
    expect(errorCode('ECONNRESET')).toBeUndefined();
  });
});

describe('describeFailure', () => {
  it('passes transport and redirect refusals through as written', () => {
    expect(describeFailure(new ServerTransportError('refused here'))).toBe('refused here');
    expect(describeFailure(new ServerRedirectError('redirected', true))).toBe('redirected');
  });

  it('names timeouts, stalls and system errors in plain words', () => {
    expect(describeFailure(new DOMException('t', 'TimeoutError'))).toBe('it did not answer in time');
    expect(describeFailure(new PullIdleTimeoutError('ollama', 'm', 1000))).toBe('it stopped sending data');
    expect(describeFailure(coded('ECONNREFUSED'))).toBe('connection refused');
    expect(describeFailure(coded('EAI_AGAIN'))).toBe('host not found');
    expect(describeFailure(coded('ENETUNREACH'))).toBe('no route to the host');
    expect(describeFailure(coded('ETIMEDOUT'))).toBe('the connection timed out');
    expect(describeFailure(coded('UND_ERR_SOCKET'))).toBe('the connection dropped');
    expect(describeFailure(new TypeError('terminated'))).toBe('the connection dropped');
    expect(describeFailure(new Error('server ended the reply before it finished'))).toBe('the connection dropped');
  });

  it('falls back to an unknown code, then the message', () => {
    expect(describeFailure(coded('EWHATEVER'))).toBe('EWHATEVER');
    expect(describeFailure(new Error('odd'))).toBe('odd');
    expect(describeFailure('plain')).toBe('plain');
  });
});
