import { describe, expect, it } from 'vitest';
import { describeErrorCause } from './describeErrorCause';

describe('describeErrorCause', () => {
  it('leads with the code of an undici-style cause', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(describeErrorCause(new TypeError('fetch failed', { cause }))).toBe('ECONNRESET: read ECONNRESET');
  });

  it('falls back to the name when the cause has no code, and chains nested causes', () => {
    const root = Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' });
    const mid = new Error('upstream failed', { cause: root });
    expect(describeErrorCause(new Error('outer', { cause: mid }))).toBe(
      'Error: upstream failed <- UND_ERR_SOCKET: socket closed'
    );
  });

  it('renders a non-Error cause as a string', () => {
    expect(describeErrorCause(new Error('outer', { cause: 'plain reason' }))).toBe('plain reason');
  });

  it('renders an object cause as JSON, never [object Object]', () => {
    expect(describeErrorCause(new Error('outer', { cause: { code: 'E_UPSTREAM', status: 502 } }))).toBe(
      '{"code":"E_UPSTREAM","status":502}'
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeErrorCause(new Error('outer', { cause: circular }))).toBe('[Unserializable]');
  });

  it('is undefined when there is no cause or the input is not an Error', () => {
    expect(describeErrorCause(new Error('plain'))).toBeUndefined();
    expect(describeErrorCause('boom')).toBeUndefined();
    expect(describeErrorCause(undefined)).toBeUndefined();
  });

  it('stops on a cyclic chain and on one longer than the cap', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(describeErrorCause(a)).toBe('Error: b <- Error: a');

    const self = new Error('self');
    self.cause = self;
    expect(describeErrorCause(self)).toBe('Error: self');

    let deep = new Error('leaf');
    for (let i = 0; i < 20; i++) deep = new Error(`level-${i}`, { cause: deep });
    expect(describeErrorCause(deep)!.split(' <- ')).toHaveLength(5);
  });
});
