import path from 'node:path';

/**
 * Build-time shaping of the service worker's precache manifest (createSerwistRoute's `globIgnores`
 * and `manifestTransforms`, paths relative to apps/client). A single precache entry the CDN answers
 * with anything but 200 rejects the whole install, and the browser then silently keeps the previous
 * worker, so nothing the hosted asset store might not serve may stay on the list.
 */

/**
 * pdf.js data files (standard fonts, CJK character maps, ICC profiles, wasm decoders) are nearly
 * 200 entries only the PDF viewer needs. The viewer fetches them on demand. They are not kept for
 * offline use.
 */
export const precacheGlobIgnores = ['public/pdfjs-assets-*/**'];

/**
 * Upper bound on precache entries taken from public/. The `.next/static` side is already limited
 * to an extension list by serwist, so public/ is the only open-ended source. Raise it deliberately
 * when a new asset set genuinely belongs in every install; a jump past it usually means a
 * directory that should be served on demand instead.
 */
export const PUBLIC_PRECACHE_CEILING = 150;

/**
 * The hosted asset store answers an extensionless file with 403, which rejects the install, so the
 * build fails on one instead of shipping a worker no returning browser can adopt.
 */
export function rejectExtensionlessEntries<T extends { url: string }>(
  manifest: T[]
): { manifest: T[]; warnings: string[] } {
  const extensionless = manifest.filter(entry => path.posix.extname(entry.url) === '').map(entry => entry.url);
  if (extensionless.length > 0) {
    throw new Error(
      `Service worker precache lists ${extensionless.length} file(s) without an extension, which the asset store does not serve: ${extensionless.join(', ')}`
    );
  }
  return { manifest, warnings: [] };
}

export const precacheManifestTransforms = [rejectExtensionlessEntries];
