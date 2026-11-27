import type { BrowserContextOptions } from 'playwright-core';
import type { OpenThumbnailContext } from './renderHtmlThumbnail';
import { THUMBNAIL_CHROMIUM_ARGS } from './renderHtmlThumbnail';
import type { RenderWorkspace } from './renderEnvironment';

/**
 * @sparticuz/chromium defaults that weaken page isolation and that a screenshot never needs. The
 * render's only boundary between author code and anything else is the browser's own origin model,
 * so same-origin policy and mixed-content blocking stay ON.
 */
const DROPPED_SPARTICUZ_ARGS = new Set(['--disable-web-security', '--allow-running-insecure-content']);

/**
 * Environment the browser process inherits. Playwright passes the whole parent environment by
 * default, which on Lambda carries the function's role credentials; the browser needs none of
 * that, only what @sparticuz/chromium sets up for fonts and its libraries. HOME and TMPDIR point
 * into the render's own workspace instead.
 */
const BROWSER_ENV_KEYS = ['PATH', 'FONTCONFIG_PATH', 'LD_LIBRARY_PATH'];

/** Opens the render's browser context inside its per-render workspace (renderEnvironment.ts). */
export type OpenWorkspaceContext = (
  options: BrowserContextOptions,
  workspace: RenderWorkspace
) => ReturnType<OpenThumbnailContext>;

/**
 * Launch the Lambda-packaged Chromium (Amazon Linux only; see infra/queues.ts for why both packages
 * ship unbundled) on the workspace's empty profile and open the render's context. Closing the
 * context closes the browser. Imported lazily so nothing else that loads this module pays for, or
 * needs, the browser packages.
 */
export const openLambdaChromiumContext: OpenWorkspaceContext = async (options, workspace) => {
  const [{ chromium: playwright }, { default: chromium }] = await Promise.all([
    import('playwright-core'),
    import('@sparticuz/chromium'),
  ]);
  const context = await playwright.launchPersistentContext(workspace.userDataDir, {
    ...options,
    args: [...chromium.args.filter(arg => !DROPPED_SPARTICUZ_ARGS.has(arg)), ...THUMBNAIL_CHROMIUM_ARGS],
    executablePath: await chromium.executablePath(),
    headless: true,
    env: { ...browserEnv(), HOME: workspace.tmpDir, TMPDIR: workspace.tmpDir },
  });
  return { context, close: () => context.close() };
};

function browserEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BROWSER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
