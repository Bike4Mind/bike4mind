import { describe, it, expect } from 'vitest';
import { getSlackApiErrorCode, isExpectedSlackWorkspaceError } from './slack-export-errors';

// Shape of the error @slack/web-api throws when Slack answers `ok: false`.
const platformError = (code: string) =>
  Object.assign(new Error(`An API error occurred: ${code}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: code },
  });

describe('getSlackApiErrorCode', () => {
  it('reads the Web API error code from a platform error', () => {
    expect(getSlackApiErrorCode(platformError('not_in_channel'))).toBe('not_in_channel');
  });

  it.each([
    ['a plain Error', new Error('socket hang up')],
    ['an HTTP error with no data', Object.assign(new Error('HTTP 503'), { code: 'slack_webapi_http_error' })],
    ['a non-string data.error', { data: { error: 42 } }],
    ['null', null],
    ['a string', 'not_in_channel'],
  ])('returns undefined for %s', (_label, error) => {
    expect(getSlackApiErrorCode(error)).toBeUndefined();
  });
});

describe('isExpectedSlackWorkspaceError', () => {
  it.each(['not_in_channel', 'channel_not_found', 'is_archived', 'token_revoked'])(
    'treats %s as an expected workspace-side state',
    code => {
      expect(isExpectedSlackWorkspaceError(platformError(code))).toBe(true);
    }
  );

  it.each([
    ['an unknown platform code', platformError('internal_error')],
    ['an HTTP 5xx error', Object.assign(new Error('HTTP 503'), { code: 'slack_webapi_http_error' })],
    ['a network error', new Error('ECONNRESET')],
    ['an error whose message only mentions the code', new Error('not_in_channel')],
  ])('keeps %s unexpected', (_label, error) => {
    expect(isExpectedSlackWorkspaceError(error)).toBe(false);
  });
});
