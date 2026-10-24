import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THUMBNAIL_CONTEXT_OPTIONS } from './renderHtmlThumbnail';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  executablePath: vi.fn(),
  newContext: vi.fn(),
  close: vi.fn(),
}));

vi.mock('playwright-core', () => ({ chromium: { launch: mocks.launch } }));
vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox', '--disable-web-security', '--allow-running-insecure-content'],
    executablePath: mocks.executablePath,
  },
}));

import { openLambdaChromiumContext } from './launchLambdaChromium';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.executablePath.mockResolvedValue('/tmp/chromium');
  mocks.launch.mockResolvedValue({ newContext: mocks.newContext, close: mocks.close });
  mocks.newContext.mockResolvedValue({});
  mocks.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('openLambdaChromiumContext', () => {
  it('keeps origin isolation enabled and passes only browser runtime environment keys', async () => {
    const runtimeEnvironment = {
      HOME: '/tmp',
      TMPDIR: '/tmp/browser',
      PATH: '/usr/bin',
      FONTCONFIG_PATH: '/tmp/fonts',
      LD_LIBRARY_PATH: '/tmp/lib',
    };
    for (const [key, value] of Object.entries(runtimeEnvironment)) vi.stubEnv(key, value);
    for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'SST_SECRET_TEST']) {
      vi.stubEnv(key, 'private-value');
    }

    const opened = await openLambdaChromiumContext(THUMBNAIL_CONTEXT_OPTIONS);

    expect(mocks.launch).toHaveBeenCalledWith({
      args: ['--no-sandbox', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      executablePath: '/tmp/chromium',
      headless: true,
      env: runtimeEnvironment,
    });
    expect(mocks.newContext).toHaveBeenCalledWith(THUMBNAIL_CONTEXT_OPTIONS);
    expect(opened.context).toBe(await mocks.newContext.mock.results[0]?.value);
    await opened.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('closes the browser and preserves the context failure even when cleanup fails', async () => {
    const contextError = new Error('context creation failed');
    mocks.newContext.mockRejectedValue(contextError);
    mocks.close.mockRejectedValue(new Error('browser close failed'));

    await expect(openLambdaChromiumContext(THUMBNAIL_CONTEXT_OPTIONS)).rejects.toBe(contextError);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
