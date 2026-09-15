import type { PublishScopeTier } from '@bike4mind/common';

/**
 * Publish - shared parser for the unified viewer namespace:
 *   /p/u|pj|o/{scopeId}/{slug}[/asset]  -> hosted HTML bundle
 *   /p/r/{publicId}                     -> published reply
 *   /p/f/{publicId}                     -> published fabfile
 *   /a/{shareToken}[/asset]             -> no-sign-in share-token link
 *                                          (the /a rewrite prepends the 'a' segment)
 *
 * Extracted from the serve route so the passphrase-gate route (issue #383) can
 * resolve the same viewer paths the browser navigates to.
 */

export const TIER_BY_PREFIX: Record<string, PublishScopeTier> = {
  u: 'user',
  pj: 'project',
  o: 'organization',
};

export interface ResolvedBundlePath {
  kind: 'bundle';
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  assetPath: string | null;
}
export interface ResolvedShortPath {
  kind: 'reply' | 'fabfile';
  publicId: string;
}
export interface ResolvedShareTokenPath {
  kind: 'share';
  shareToken: string;
  assetPath: string | null;
}
export type ResolvedPath = ResolvedBundlePath | ResolvedShortPath | ResolvedShareTokenPath;

export function parsePublishPath(segments: string[]): ResolvedPath | null {
  if (segments.length < 2) return null;
  const head = segments[0];

  if (head === 'r' || head === 'f') {
    return { kind: head === 'r' ? 'reply' : 'fabfile', publicId: segments[1] };
  }
  if (head === 'a') {
    return { kind: 'share', shareToken: segments[1], assetPath: segments.slice(2).join('/') || null };
  }
  const tier = TIER_BY_PREFIX[head];
  if (!tier) return null;
  if (segments.length < 3) return null;
  return {
    kind: 'bundle',
    tier,
    scopeId: segments[1],
    slug: segments[2],
    assetPath: segments.slice(3).join('/') || null,
  };
}

/** Parse a browser `location.pathname` (`/p/...`, `/uc/...`, or `/a/...`) into
 *  segments for parsePublishPath; null when the pathname is not a viewer path.
 *  For `/a/<token>` paths the 'a' head segment is preserved (it is the kind). */
export function segmentsFromViewerPathname(pathname: string): string[] | null {
  const share = /^\/a\/(.+)$/.exec(pathname);
  if (share) {
    return [
      'a',
      ...share[1]
        .split('/')
        .map(s => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        })
        .filter(Boolean),
    ];
  }
  const m = /^\/(?:p|uc)\/(.+)$/.exec(pathname);
  if (!m) return null;
  return m[1]
    .split('/')
    .map(s => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .filter(Boolean);
}
