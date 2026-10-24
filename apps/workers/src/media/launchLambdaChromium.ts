import type { OpenThumbnailContext } from './renderHtmlThumbnail';
import { THUMBNAIL_CHROMIUM_ARGS } from './renderHtmlThumbnail';

/**
 * @sparticuz/chromium defaults that weaken page isolation and that a screenshot never needs. The
 * render's only boundary between author code and anything else is the browser's own origin model,
 * so same-origin policy and mixed-content blocking stay ON.
 */
const DROPPED_SPARTICUZ_ARGS = new Set(['--disable-web-security', '--allow-running-insecure-content']);

/**
 * Environment the browser process inherits. Playwright passes the whole parent environment by
 * default, which on Lambda carries the role credentials and the key to the linked secrets; the
 * renderer needs none of that, only what @sparticuz/chromium sets up for fonts and its libraries.
 */
const BROWSER_ENV_KEYS = ['HOME', 'TMPDIR', 'PATH', 'FONTCONFIG_PATH', 'LD_LIBRARY_PATH'];

/**
 * Launch the Lambda-packaged Chromium (Amazon Linux only; see infra/queues.ts for why both packages
 * ship unbundled) and open one context for a thumbnail render. Imported lazily so nothing else that
 * loads this module pays for, or needs, the browser packages.
 */
export const openLambdaChromiumContext: OpenThumbnailContext = async options => {
  const [{ chromium: playwright }, { default: chromium }] = await Promise.all([
    import('playwright-core'),
    import('@sparticuz/chromium'),
  ]);
  const browser = await playwright.launch({
    args: [...chromium.args.filter(arg => !DROPPED_SPARTICUZ_ARGS.has(arg)), ...THUMBNAIL_CHROMIUM_ARGS],
    executablePath: await chromium.executablePath(),
    headless: true,
    env: browserEnv(),
  });
  try {
    const context = await browser.newContext(options);
    return { context, close: () => browser.close() };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err;
  }
};

function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BROWSER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
