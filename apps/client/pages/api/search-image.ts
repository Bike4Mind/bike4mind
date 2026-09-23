import { cacheRepository } from '@bike4mind/database';
import { isExecutableUploadMimeType, stripImageUrlSignature, verifyImageUrlSignature } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Config } from '@server/utils/config';
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
 * `url` must carry a valid HMAC signature (verifyImageUrlSignature, checked first below) before
 * anything else runs. Without that, this would be an arbitrary-URL fetcher for any signed-in user:
 * the `b4m_cards` fence is model-authored, and nothing stops a hostile page's snippet text from
 * steering the model into writing an attacker-controlled URL with exfiltrated conversation data in
 * the query string - which this route would then fetch server-side as a beacon. The signature is
 * applied to every image URL where it's first shown to the model (websearch/index.ts's `Images:`
 * lines), using the same SECRET_ENCRYPTION_KEY as ChatCompletionFeatures.telemetryHmacSecret, so
 * only a URL that genuinely came from a search result can verify here. `verifyImageUrlSignature`
 * itself refuses to pass on an unconfigured or placeholder secret, so a deploy that never set a
 * real SECRET_ENCRYPTION_KEY fails closed (every image "Image unavailable") rather than accepting
 * anything. The signature is stripped before the fetch (`stripImageUrlSignature`) so the upstream
 * host only ever sees the exact URL the search provider returned. The per-user minute cap below is
 * a second, independent bound against egress-amplification abuse of the vetted URLs themselves.
 */

const SearchImageQuery = z.object({
  url: z.string().url('url must be a valid URL'),
});

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const BROWSER_CACHE_SECONDS = 3600;
const MINUTE_IN_MS = 60_000;
// A card row is at most 8 cards x 4 images = ~32 requests (~3 rows/minute); this leaves room for
// a few rows a minute per user while keeping a scripted loop from turning the app into someone's
// download service.
const REQUESTS_PER_MINUTE = 120;

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const { url: rawUrl } = SearchImageQuery.parse(req.query);
    const brand = process.env.APP_NAME || '';

    if (!verifyImageUrlSignature(rawUrl, Config.SECRET_ENCRYPTION_KEY || '')) {
      // No host/reason in the log: an unsigned or tampered URL is exactly the shape a scripted
      // probe would send, and this is reachable by every signed-in user.
      req.logger.warn('Rejected unsigned image URL on /api/search-image');
      throw new BadRequestError('Image URL is not allowed');
    }
    // The upstream never sees the app's own query param - it gets exactly the URL the provider
    // returned, byte for byte, which also matters for a presigned CDN link whose own signature
    // covers its query string.
    const fetchUrl = stripImageUrlSignature(rawUrl);

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
        response = await safeFetch(fetchUrl, {
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
          req.logger.warn('Blocked SSRF attempt on /api/search-image', { url: fetchUrl, reason: e.message });
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
        req.logger.warn('Rejected non-image content-type on /api/search-image', { url: fetchUrl, contentType });
        throw new BadRequestError('Response is not an image');
      }

      let buffer: Buffer;
      try {
        buffer = await streamWithSizeLimit(response, MAX_IMAGE_BYTES);
      } catch (e) {
        // The timeout is armed across this read too (see the comment on `timeoutId` above), so a
        // slow-drip upstream aborts here, not in safeFetch - map it the same way, rather than
        // letting a bare AbortError escape as a 500 and page on-call.
        if (e instanceof Error && e.name === 'AbortError') {
          throw new BadRequestError('Image fetch timed out');
        }
        throw e;
      }

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
