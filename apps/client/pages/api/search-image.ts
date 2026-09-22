import { cacheRepository } from '@bike4mind/database';
import { isExecutableUploadMimeType } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, TooManyRequestsError } from '@server/utils/errors';
import { safeFetch, SsrfError } from '@server/utils/ssrfProtection';
import { streamWithSizeLimit } from '@server/utils/streamWithSizeLimit';
import { z } from 'zod';

/**
 * Same-origin read-through for the third-party thumbnails on web-search result cards
 * (SearchResultCards.tsx).
 *
 * Why a proxy at all: the app's CSP in proxy.ts pins `img-src` to a short allowlist, and search
 * results come from arbitrary hosts that can never be on it, so a hotlinked <img> is blocked
 * outright. Serving the bytes from 'self' is what makes the cards renderable without relaxing a
 * security header app-wide, and it keeps the viewer's IP off third-party hosts.
 *
 * Why not /api/external-image: that route is admin-only and caches permanently to S3. These
 * thumbnails are transient, per-conversation, and fetched for every user, so nothing is persisted
 * here - the browser cache is the only cache.
 *
 * The caller is the SPA's fetch (not a bare <img src>): auth is a bearer JWT, which only the axios
 * client can attach, so SearchResultCards reads this through `api` and renders the bytes as a
 * blob: URL. jwtOnly because an API key cannot be in play on that path at all.
 *
 * `url` is unconstrained beyond the SSRF guard - nothing proves it came from a search result - so
 * this is an arbitrary-URL fetcher for any signed-in user. The per-user minute cap below is what
 * bounds it as an egress-amplification and request-laundering surface; /api/external-image's
 * answer to the same problem was to admit only admins.
 */

const SearchImageQuery = z.object({
  url: z.string().url('url must be a valid URL'),
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const BROWSER_CACHE_SECONDS = 3600;
const MINUTE_IN_MS = 60_000;
// A card row is at most ~8 cards x 3 tiles; this leaves room for a few rows a minute per user
// while keeping a scripted loop from turning the app into someone's download service.
const REQUESTS_PER_MINUTE = 120;

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const { url: rawUrl } = SearchImageQuery.parse(req.query);
    const brand = process.env.APP_NAME || '';

    const quota = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `search-image-rate-limit:${req.user.id}:minute`,
      REQUESTS_PER_MINUTE,
      MINUTE_IN_MS
    );
    if (!quota.success) {
      throw new TooManyRequestsError('Too many image requests. Try again shortly.');
    }

    const controller = new AbortController();
    // Armed across the BODY read too, not just the headers: an upstream that answers with image
    // headers and then drips one byte at a time stays under the size cap forever and would
    // otherwise pin the request until the platform timeout. Aborting the fetch errors the reader.
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        // safeFetch asserts https + non-private target, then re-validates a single redirect hop,
        // so the CDN redirects these thumbnails routinely use still work.
        response = await safeFetch(rawUrl, {
          headers: {
            'User-Agent': `Lumina5-SearchImageProxy/1.0${brand ? ` (${brand})` : ''}`,
            Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
          },
          signal: controller.signal,
        });
      } catch (e) {
        if (e instanceof SsrfError) {
          // The reason names the host and the private address it resolved to. Every signed-in
          // user can reach this route, so echoing it back would make the app an internal-DNS
          // oracle - keep the detail in the log, hand the caller nothing.
          req.logger.warn('Blocked SSRF attempt on /api/search-image', { url: rawUrl, reason: e.message });
          throw new BadRequestError('Image URL is not allowed');
        }
        if (e instanceof Error && e.name === 'AbortError') {
          throw new BadRequestError('Image fetch timed out');
        }
        throw e;
      }

      if (!response.ok) {
        throw new BadRequestError(`Failed to fetch image: ${response.status}`);
      }

      // image/svg+xml passes startsWith('image/') but is a scriptable document, and this route
      // serves its bytes back from the APP origin - so an SVG here would run with the app's own
      // privileges. Reject it and every other executable type.
      const contentType = (response.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
      if (!contentType.startsWith('image/') || isExecutableUploadMimeType(contentType)) {
        req.logger.warn('Rejected non-image content-type on /api/search-image', { url: rawUrl, contentType });
        throw new BadRequestError('Response is not an image');
      }

      const buffer = await streamWithSizeLimit(response, MAX_IMAGE_BYTES);

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buffer.byteLength));
      // `private` keeps a signed-in user's thumbnails out of any shared cache in front of the app.
      res.setHeader('Cache-Control', `private, max-age=${BROWSER_CACHE_SECONDS}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      return res.status(200).send(buffer);
    } finally {
      clearTimeout(timeoutId);
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
