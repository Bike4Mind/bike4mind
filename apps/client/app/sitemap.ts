import type { MetadataRoute } from 'next';
import { WEBSITE_URL } from '@client/config/general';
import { premiumRouteIndexing } from './premium-generated/premiumRouteIndexing.generated';
import { buildSitemapPaths, normalizeOrigin } from './seo/crawlPolicy';

export const dynamic = 'force-static';

// Sitemap entries must be absolute, so an unset NEXT_PUBLIC_WEBSITE_URL (open core,
// self-host) yields an empty urlset rather than a file full of relative paths that
// every crawler would reject.
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = normalizeOrigin(WEBSITE_URL);
  if (!origin) return [];

  return buildSitemapPaths(premiumRouteIndexing).map(path => ({ url: `${origin}${path}` }));
}
