import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THUMBNAIL_CONTEXT_OPTIONS } from './renderHtmlThumbnail';

const mocks = vi.hoisted(() => ({
  launchPersistentContext: vi.fn(),
  executablePath: vi.fn(),
  close: vi.fn(),
}));

vi.mock('playwright-core', () => ({ chromium: { launchPersistentContext: mocks.launchPersistentContext } }));
vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox', '--disable-web-security', '--allow-running-insecure-content'],
    executablePath: mocks.executablePath,
  },
}));

import { openLambdaChromiumContext } from './launchLambdaChromium';

const WORKSPACE = { userDataDir: '/tmp/thumbnail-render-abc/profile', tmpDir: '/tmp/thumbnail-render-abc/tmp' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.executablePath.mockResolvedValue('/tmp/chromium');
  mocks.launchPersistentContext.mockResolvedValue({ close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openLambdaChromiumContext', () => {
  it("launches on the workspace's empty profile, keeps origin isolation on, and passes only the browser's runtime environment", async () => {
    const runtimeEnvironment = { PATH: '/usr/bin', FONTCONFIG_PATH: '/tmp/fonts', LD_LIBRARY_PATH: '/tmp/lib' };
    for (const [key, value] of Object.entries(runtimeEnvironment)) vi.stubEnv(key, value);
    vi.stubEnv('HOME', '/tmp');
    vi.stubEnv('TMPDIR', '/tmp');
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'SST_SECRET_TEST']) {
      vi.stubEnv(key, 'private-value');
    }

    const opened = await openLambdaChromiumContext(THUMBNAIL_CONTEXT_OPTIONS, WORKSPACE);

    expect(mocks.launchPersistentContext).toHaveBeenCalledWith(WORKSPACE.userDataDir, {
      ...THUMBNAIL_CONTEXT_OPTIONS,
      args: ['--no-sandbox', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      executablePath: '/tmp/chromium',
      headless: true,
      env: { ...runtimeEnvironment, HOME: WORKSPACE.tmpDir, TMPDIR: WORKSPACE.tmpDir },
    });
    expect(opened.context).toBe(await mocks.launchPersistentContext.mock.results[0]?.value);
    await opened.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('propagates a launch failure; Playwright reaps the browser and the render environment checks it', async () => {
    const launchError = new Error('Failed to launch the browser process');
    mocks.launchPersistentContext.mockRejectedValue(launchError);

    await expect(openLambdaChromiumContext(THUMBNAIL_CONTEXT_OPTIONS, WORKSPACE)).rejects.toBe(launchError);
  });
});
