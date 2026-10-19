import { describe, it, expect, vi } from 'vitest';
import { logOAuthError } from './oauthErrorLog';

const lineFor = (clientId: unknown) => {
  const warn = vi.fn();
  logOAuthError({ warn }, { route: 'oauth/token', clientId, error: 'invalid_grant', status: 400 });
  expect(warn).toHaveBeenCalledTimes(1);
  return String(warn.mock.calls[0][0]);
};

describe('logOAuthError', () => {
  it('emits one key=value line with exactly the four fields', () => {
    expect(lineFor('client-1')).toBe('[OAUTH_ERROR] route=oauth/token client=client-1 error=invalid_grant status=400');
  });

  it('strips characters that could forge or split a log line', () => {
    expect(lineFor('a\nb c\r[OAUTH_ERROR]')).toContain('client=abcOAUTH_ERROR error=');
  });

  it('caps an oversized client at 128 chars', () => {
    expect(lineFor('x'.repeat(500))).toContain(`client=${'x'.repeat(128)} error=`);
  });

  it.each([undefined, null, 42, { id: 'c' }, ['c'], '\n\n'])('logs %j as client=unknown', clientId => {
    expect(lineFor(clientId)).toContain('client=unknown error=');
  });

  it('never throws, with no logger or a throwing one', () => {
    const args = { route: 'r', clientId: 'c', error: 'e', status: 400 };
    expect(() => logOAuthError(undefined, args)).not.toThrow();
    expect(() =>
      logOAuthError(
        {
          warn: () => {
            throw new Error('boom');
          },
        },
        args
      )
    ).not.toThrow();
  });
});
