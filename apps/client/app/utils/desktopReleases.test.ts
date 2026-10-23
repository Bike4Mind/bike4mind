import { describe, expect, it } from 'vitest';
import { DESKTOP_RELEASES_PAGE_URL, parseDesktopRelease } from './desktopReleases';

const BASE = 'https://github.com/Bike4Mind/desktop-releases';

const githubRelease = (overrides: Record<string, unknown> = {}) => ({
  tag_name: 'desktop-v0.42.0',
  html_url: `${BASE}/releases/tag/desktop-v0.42.0`,
  assets: [
    {
      name: 'Bike4Mind-0.42.0-arm64.dmg',
      browser_download_url: `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-arm64.dmg`,
    },
    {
      name: 'Bike4Mind-0.42.0-x64.AppImage',
      browser_download_url: `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-x64.AppImage`,
    },
    { name: 'install.sh', browser_download_url: `${BASE}/releases/download/desktop-v0.42.0/install.sh` },
    { name: 'SHA256SUMS.txt', browser_download_url: `${BASE}/releases/download/desktop-v0.42.0/SHA256SUMS.txt` },
  ],
  ...overrides,
});

describe('parseDesktopRelease', () => {
  it('reads the version and the per-platform downloads', () => {
    expect(parseDesktopRelease(githubRelease())).toEqual({
      version: '0.42.0',
      releaseUrl: `${BASE}/releases/tag/desktop-v0.42.0`,
      macArm64DmgUrl: `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-arm64.dmg`,
      linuxX64AppImageUrl: `${BASE}/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-x64.AppImage`,
    });
  });

  it('leaves a missing asset undefined', () => {
    const release = parseDesktopRelease(githubRelease({ assets: [] }));
    expect(release?.macArm64DmgUrl).toBeUndefined();
    expect(release?.linuxX64AppImageUrl).toBeUndefined();
  });

  it('drops links that point outside the releases repo', () => {
    const release = parseDesktopRelease(
      githubRelease({
        html_url: 'https://example.com/release',
        assets: [{ name: 'Bike4Mind-0.42.0-arm64.dmg', browser_download_url: 'https://example.com/a-arm64.dmg' }],
      })
    );
    expect(release?.releaseUrl).toBe(DESKTOP_RELEASES_PAGE_URL);
    expect(release?.macArm64DmgUrl).toBeUndefined();
  });

  it('drops links that only share a prefix with the releases repo', () => {
    const release = parseDesktopRelease(
      githubRelease({
        html_url: 'https://github.com/Bike4Mind/desktop-releases-evil/releases/tag/desktop-v0.42.0',
        assets: [
          {
            name: 'Bike4Mind-0.42.0-arm64.dmg',
            browser_download_url:
              'https://github.com/someone-else/desktop-releases/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-arm64.dmg',
          },
          {
            name: 'Bike4Mind-0.42.0-x64.AppImage',
            browser_download_url:
              'https://github.com/Bike4Mind/desktop-releases-evil/releases/download/desktop-v0.42.0/Bike4Mind-0.42.0-x64.AppImage',
          },
        ],
      })
    );
    expect(release?.releaseUrl).toBe(DESKTOP_RELEASES_PAGE_URL);
    expect(release?.macArm64DmgUrl).toBeUndefined();
    expect(release?.linuxX64AppImageUrl).toBeUndefined();
  });

  it('rejects a response that is not a release, such as a rate-limit error body', () => {
    expect(parseDesktopRelease({ message: 'API rate limit exceeded' })).toBeNull();
    expect(parseDesktopRelease(null)).toBeNull();
  });
});
