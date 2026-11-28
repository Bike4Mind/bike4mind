import { describe, expect, it } from 'vitest';
import { buildAuthSuccessUrl, omitAuthToken } from '../../e2e/helpers/auth-seed';
import { redactAuthError } from '../../e2e/helpers/error-text';
import type { TestError } from '@playwright/test/reporter';

const auth = { accessToken: 'aaa.bbb-ccc_ddd.eee', userId: 'user1' };

describe('omitAuthToken', () => {
  it('replaces the token buildAuthSuccessUrl writes and keeps the rest of the URL', () => {
    const url = buildAuthSuccessUrl('/projects', auth);
    const text = `page.goto: Timeout 30000ms exceeded.\n  - navigating to "https://app.test${url}", waiting until "load"`;

    const result = omitAuthToken(text);

    expect(result).not.toContain(auth.accessToken);
    expect(result).toContain('/auth/success?redirectTo=%2Fprojects#token=[omitted]&userId=user1"');
    expect(result).toContain('Timeout 30000ms exceeded');
  });

  it('replaces every occurrence, including a percent-encoded value', () => {
    const result = omitAuthToken('a /x#token=one.two b /y?next=1&token=three%2Bfour c');

    expect(result).toBe('a /x#token=[omitted] b /y?next=1&token=[omitted] c');
  });

  it('leaves text without a token parameter unchanged', () => {
    const text = 'expect(locator).toBeVisible() failed: tokens=3, id_token: none';

    expect(omitAuthToken(text)).toBe(text);
  });
});

describe('redactAuthError', () => {
  it('retains diagnostics while scrubbing messages, stacks, thrown values and causes', () => {
    const error: TestError = {
      message: `Timeout /auth/success#token=${auth.accessToken}`,
      stack: `at /auth/success#token=${auth.accessToken}`,
      value: `/auth/success#token=${auth.accessToken}`,
      cause: { message: `Cause /auth/success#token=${auth.accessToken}` },
    };
    redactAuthError(error);
    expect(JSON.stringify(error)).not.toContain(auth.accessToken);
    expect(error.message).toBe('Timeout /auth/success#token=[omitted]');
    expect(error.cause?.message).toBe('Cause /auth/success#token=[omitted]');
  });

  it('leaves token-free diagnostics unchanged and terminates on a repeated cause', () => {
    const error: TestError = { message: 'Useful diagnostic' };
    error.cause = error;
    redactAuthError(error);
    expect(error.message).toBe('Useful diagnostic');
    expect(error.cause).toBe(error);
  });
});
