import { describe, expect, it } from 'vitest';
import { resolveSessionOrigin } from './sessionOrigin';

describe('resolveSessionOrigin', () => {
  it('stamps api with the key id for an API-key request', () => {
    expect(resolveSessionOrigin({ apiKeyInfo: { keyId: 'key-1' }, headers: {} })).toEqual({
      channel: 'api',
      apiKeyId: 'key-1',
    });
  });

  it('keeps api for an API-key request even when it carries the CLI header', () => {
    expect(
      resolveSessionOrigin({ apiKeyInfo: { keyId: 'key-1' }, headers: { 'x-b4m-client': 'b4m-cli/1.0.0' } }).channel
    ).toBe('api');
  });

  it('stamps cli for a JWT request from the CLI', () => {
    expect(resolveSessionOrigin({ headers: { 'x-b4m-client': 'b4m-cli/1.0.0' } })).toEqual({ channel: 'cli' });
  });

  it('stamps web for a plain JWT request', () => {
    expect(resolveSessionOrigin({ headers: { 'user-agent': 'Mozilla/5.0' } })).toEqual({ channel: 'web' });
  });
});
