import { describe, expect, it } from 'vitest';
import { HOST_ERROR_CODES, hostFailure, hostNotification, hostRequest, hostResult, parseHostMessage } from './envelope';

describe('parseHostMessage', () => {
  it('round-trips a request', () => {
    const message = hostRequest(7, 'session/get', { sessionId: 's1' });
    expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });

  it('round-trips a request with a string id and no params', () => {
    const message = hostRequest('abc', 'host/info');
    expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });

  it('round-trips a success response, including a null result', () => {
    for (const result of [{ a: 1 }, null]) {
      const message = hostResult(1, result);
      expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    }
  });

  it('round-trips an error response, with and without an id', () => {
    for (const id of [3, null]) {
      const message = hostFailure(id, HOST_ERROR_CODES.sessionNotFound, 'nope', { sessionId: 's1' });
      expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
    }
  });

  it('round-trips a notification', () => {
    const message = hostNotification('host/stateChanged', { account: null });
    expect(parseHostMessage(JSON.parse(JSON.stringify(message)))).toEqual({ ok: true, message });
  });

  it('rejects a wrong jsonrpc version', () => {
    expect(parseHostMessage({ jsonrpc: '1.0', id: 1, method: 'host/info' }).ok).toBe(false);
    expect(parseHostMessage({ jsonrpc: '1.0', id: 1, result: {} }).ok).toBe(false);
    expect(parseHostMessage({ jsonrpc: '1.0', method: 'host/stateChanged' }).ok).toBe(false);
  });

  it('rejects a response carrying both result and error', () => {
    const both = { jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'x' } };
    expect(parseHostMessage(both).ok).toBe(false);
  });

  it('rejects a request without a method', () => {
    expect(parseHostMessage({ jsonrpc: '2.0', id: 1 }).ok).toBe(false);
  });

  it('rejects a response that has neither result nor error', () => {
    expect(parseHostMessage({ jsonrpc: '2.0', id: 1 }).ok).toBe(false);
  });

  it('does not read a request with a malformed id as a notification', () => {
    expect(parseHostMessage({ jsonrpc: '2.0', id: {}, method: 'host/info' }).ok).toBe(false);
  });

  it('rejects non-objects without throwing', () => {
    for (const raw of [null, undefined, 42, 'text', [], [{ jsonrpc: '2.0' }]]) {
      const parsed = parseHostMessage(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe(HOST_ERROR_CODES.invalidRequest);
    }
  });

  it('accepts unknown extra keys', () => {
    expect(parseHostMessage({ jsonrpc: '2.0', id: 1, method: 'host/info', extra: true }).ok).toBe(true);
    expect(parseHostMessage({ jsonrpc: '2.0', id: 1, result: {}, extra: true }).ok).toBe(true);
    expect(parseHostMessage({ jsonrpc: '2.0', method: 'later/thing', extra: true }).ok).toBe(true);
    expect(
      parseHostMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x', extra: 1 }, extra: true }).ok
    ).toBe(true);
  });

  it('rejects a non-integer error code', () => {
    expect(parseHostMessage({ jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'x' } }).ok).toBe(false);
  });
});
