import { describe, expect, it } from 'vitest';
import { buildAuthSuccessUrl, omitAuthToken } from '../../e2e/helpers/auth-seed';

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
