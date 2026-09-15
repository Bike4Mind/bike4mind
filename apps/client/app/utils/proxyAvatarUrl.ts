/**
 * Proxy external avatar URLs through Next.js image optimization.
 * This avoids browser CSP / net::ERR_FAILED issues by loading
 * the image server-side and serving from the same origin.
 *
 * Product-neutral core utility. Lives in core so that premium overlay components
 * can consume it without creating a static import from a generic core surface
 * into a premium package.
 */
export function proxyAvatarUrl(url: string | undefined, size = 96): string | undefined {
  if (!url) return undefined;
  return `/_next/image?url=${encodeURIComponent(url)}&w=${size}&q=75`;
}
