import { describe, expect, it } from 'vitest';
import { proxyAvatarUrl } from './proxyAvatarUrl';

describe('proxyAvatarUrl', () => {
  it.each([
    ['https://github.com/octocat.png', 'https://avatars.githubusercontent.com/octocat'],
    ['https://github.com/test-user.png?size=96', 'https://avatars.githubusercontent.com/test-user?size=96'],
    ['https://avatars.githubusercontent.com/u/583231?v=4', 'https://avatars.githubusercontent.com/u/583231?v=4'],
    ['https://github.com/org/repo/blob/main/image.png', 'https://github.com/org/repo/blob/main/image.png'],
    ['https://github.com.evil.example/octocat.png', 'https://github.com.evil.example/octocat.png'],
    ['/profile-photos/avatar.png', '/profile-photos/avatar.png'],
  ])('proxies %s using its direct avatar source', (source, expected) => {
    const result = new URL(proxyAvatarUrl(source, 128)!, 'https://app.example.com');
    expect(result.pathname).toBe('/_next/image');
    expect(result.searchParams.get('url')).toBe(expected);
    expect(result.searchParams.get('w')).toBe('128');
    expect(result.searchParams.get('q')).toBe('75');
  });

  it('preserves the absent-avatar fallback', () => {
    expect(proxyAvatarUrl(undefined)).toBeUndefined();
    expect(proxyAvatarUrl('')).toBeUndefined();
  });
});
