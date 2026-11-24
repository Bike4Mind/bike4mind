import { describe, it, expect } from 'vitest';
import { isSlackConfigTokenAuthError, SLACK_CONFIG_TOKEN_AUTH_ERRORS } from './slackConfigTokenErrors';

describe('isSlackConfigTokenAuthError', () => {
  it.each(SLACK_CONFIG_TOKEN_AUTH_ERRORS)('treats %s as a token auth error', code => {
    expect(isSlackConfigTokenAuthError(code)).toBe(true);
  });

  it.each(['app_not_found', 'invalid_manifest', 'internal_error', 'ratelimited', 'missing_scope', ''])(
    'does not treat %s as a token auth error',
    code => {
      expect(isSlackConfigTokenAuthError(code)).toBe(false);
    }
  );

  it.each([undefined, null, 42, { error: 'invalid_auth' }])('returns false for non-string %j', value => {
    expect(isSlackConfigTokenAuthError(value)).toBe(false);
  });
});
