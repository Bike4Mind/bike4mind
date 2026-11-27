import { describe, it, expect } from 'vitest';
import { oauthProviderErrorCode } from './oauthProviderErrorCode';

describe('oauthProviderErrorCode', () => {
  it('passes a known RFC 6749 code through', () => {
    expect(oauthProviderErrorCode('access_denied')).toBe('access_denied');
    expect(oauthProviderErrorCode('server_error')).toBe('server_error');
  });

  it('collapses free text and non-strings to unrecognized', () => {
    expect(oauthProviderErrorCode('call 555-0100 for support')).toBe('unrecognized');
    expect(oauthProviderErrorCode(['access_denied'])).toBe('unrecognized');
  });

  it('returns undefined when the param is absent', () => {
    expect(oauthProviderErrorCode(undefined)).toBeUndefined();
    expect(oauthProviderErrorCode('')).toBeUndefined();
  });
});
