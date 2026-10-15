import { describe, expect, it } from 'vitest';
import { resolveFeedUrl, resolveInstallerUrl } from './feed';

describe('resolveFeedUrl', () => {
  it('treats nothing configured as "this build does not update"', () => {
    expect(resolveFeedUrl(undefined)).toBeNull();
    expect(resolveFeedUrl(null)).toBeNull();
    expect(resolveFeedUrl('')).toBeNull();
    expect(resolveFeedUrl('   ')).toBeNull();
  });

  it('accepts https and normalises it', () => {
    expect(resolveFeedUrl('https://example.test/releases')).toBe('https://example.test/releases');
    expect(resolveFeedUrl('  https://example.test/releases/  ')).toBe('https://example.test/releases/');
  });

  it('refuses plaintext from a real host, so nobody on the path picks the build', () => {
    expect(resolveFeedUrl('http://example.test/releases')).toBeNull();
  });

  it('allows plaintext on the loopback, which is how the check path is exercised locally', () => {
    expect(resolveFeedUrl('http://localhost:8080/releases')).toBe('http://localhost:8080/releases');
    expect(resolveFeedUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
  });

  it('refuses anything that is not a url, and any other scheme', () => {
    expect(resolveFeedUrl('not a url')).toBeNull();
    expect(resolveFeedUrl('/releases')).toBeNull();
    expect(resolveFeedUrl('file:///tmp/releases')).toBeNull();
    expect(resolveFeedUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('resolveInstallerUrl', () => {
  const installers = { arm64: 'https://example.test/a-arm64.dmg', x64: 'http://example.test/a-x64.dmg' };

  it('picks the https installer for this arch', () => {
    expect(resolveInstallerUrl(installers, 'arm64')).toBe('https://example.test/a-arm64.dmg');
  });

  it('refuses anything else the feed could hand the browser', () => {
    expect(resolveInstallerUrl(installers, 'x64')).toBeNull();
    expect(resolveInstallerUrl(installers, 'ia32')).toBeNull();
    expect(resolveInstallerUrl({ arm64: 'not a url' }, 'arm64')).toBeNull();
    expect(resolveInstallerUrl(undefined, 'arm64')).toBeNull();
    expect(resolveInstallerUrl('https://example.test/a.dmg', 'arm64')).toBeNull();
  });
});
