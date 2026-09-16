import type { MetadataRoute } from 'next';
import { CANONICAL_ORIGIN } from '@client/config/general';
import { premiumRouteIndexing } from './premium-generated/premiumRouteIndexing.generated';
import { buildDisallowList, buildSitemapPaths, buildSitemapUrl } from './seo/crawlPolicy';

// Built once at build time rather than served from a Lambda per request: the policy is
// pure data, so a static file is both cheaper and CDN-cacheable. Matches layout.tsx.
export const dynamic = 'force-static';

// A single `User-agent: *` group on purpose. Named groups for AI crawlers are a policy
// decision about this product, not a mechanical one, and getting them wrong is silent -
// see the group trap in seo/crawlPolicy.ts before adding any.
export default function robots(): MetadataRoute.Robots {
  const sitemapUrl = buildSitemapUrl(CANONICAL_ORIGIN, buildSitemapPaths(premiumRouteIndexing));

  return {
    rules: [{ userAgent: '*', allow: '/', disallow: buildDisallowList(premiumRouteIndexing) }],
    ...(sitemapUrl ? { sitemap: sitemapUrl } : {}),
  };
}
