import { z } from 'zod';

const RELEASES_REPO = 'Bike4Mind/desktop-releases';
const RELEASES_ORIGIN = `https://github.com/${RELEASES_REPO}/`;

// Version-free links that always resolve to the newest release, so the download page still
// works when the GitHub API is unreachable or rate limited (60 requests/hour per IP, unauthenticated).
export const DESKTOP_ALL_RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
export const DESKTOP_RELEASES_PAGE_URL = `https://github.com/${RELEASES_REPO}/releases/latest`;
export const DESKTOP_INSTALL_SCRIPT_URL = `https://github.com/${RELEASES_REPO}/releases/latest/download/install.sh`;
export const DESKTOP_INSTALL_COMMAND = `curl -fsSL ${DESKTOP_INSTALL_SCRIPT_URL} | sh`;

// Must stay in the client CSP's connect-src (apps/client/proxy.ts).
export const DESKTOP_LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;

export interface DesktopRelease {
  version: string;
  releaseUrl: string;
  macArm64DmgUrl?: string;
  linuxX64AppImageUrl?: string;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

// Only links into the releases repo are rendered, whatever the API response says.
const fromReleasesRepo = (url: string | undefined) => (url?.startsWith(RELEASES_ORIGIN) ? url : undefined);

/** Reads the fields the download page needs from a GitHub "latest release" response; null if it is not one. */
export function parseDesktopRelease(json: unknown): DesktopRelease | null {
  const parsed = releaseSchema.safeParse(json);
  if (!parsed.success) return null;
  const { tag_name, html_url, assets } = parsed.data;
  const assetUrl = (pattern: RegExp) =>
    fromReleasesRepo(assets.find(asset => pattern.test(asset.name))?.browser_download_url);
  return {
    version: tag_name.replace(/^desktop-v/, ''),
    releaseUrl: fromReleasesRepo(html_url) ?? DESKTOP_RELEASES_PAGE_URL,
    macArm64DmgUrl: assetUrl(/-arm64\.dmg$/),
    linuxX64AppImageUrl: assetUrl(/-x64\.AppImage$/),
  };
}

export async function fetchLatestDesktopRelease(signal?: AbortSignal): Promise<DesktopRelease> {
  // Plain fetch, not the app's axios instance: that one attaches the user's bearer token.
  const response = await fetch(DESKTOP_LATEST_RELEASE_API_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(`GitHub releases API responded ${response.status}`);
  const release = parseDesktopRelease(await response.json());
  if (!release) throw new Error('Unexpected GitHub releases API response');
  return release;
}
