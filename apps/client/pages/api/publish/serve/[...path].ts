import { baseApi } from '@server/middlewares/baseApi';
import { apiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import { rateLimit } from '@server/middlewares/rateLimit';
import type { Request, Response, NextFunction } from 'express';
import { marked } from 'marked';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import { PublishedArtifact } from '@bike4mind/database';
import {
  buildPublishUrlPath,
  checkShareGrant,
  checkVisibility,
  collectInlineAssets,
  prepareShareMeta,
  renderBundleLoaderShell,
  renderSandboxedBundle,
  stripToText,
  type PublishUser,
  type SandboxAsset,
} from '@server/services/publish';
import { PUBLISH_HOST } from '@server/services/publish/validateBundle';
import {
  buildBundleScriptSrc,
  escapeHtml,
  resolveDocOrigin,
  sanitizeRenderedHtml,
  usercontentHostFor,
  publicIdFromUsercontentHost,
  isAppWrapperHost,
} from '@server/services/publish/viewerSecurity';
import { buildShareFooterHtml } from '@client/app/utils/shareFooter';
import type { PublishScopeTier, PublishVisibility } from '@bike4mind/common';

/**
 * GET /api/publish/serve/[...path] - the public viewer for published artifacts.
 * Mapped to the pretty `/p/*` URL via the rewrite in next.config.mjs. Ported
 * from Polaris Publish v1 via the artifact-publishing blueprint.
 *
 * Unified namespace:
 *   /p/u|pj|o/{scopeId}/{slug}[/asset]  -> hosted HTML bundle
 *   /p/r/{publicId}                     -> published reply (rendered markdown)
 *   /p/f/{publicId}                     -> published fabfile (rendered text)
 *
 * Bundles are served inside a sandboxed iframe: the `/p/...` HTML response
 * is a minimal trusted wrapper page whose only content is an
 * `<iframe sandbox="allow-scripts" srcdoc=...>` (NO `allow-same-origin`). The
 * bundle therefore runs on an opaque (`null`) origin - author inline JS executes,
 * but it cannot read the app origin's localStorage/cookies or call `/api/*` with
 * the viewer's credentials. The visibility check still runs on the app origin
 * (parent) for the HTML AND every asset request; gated bundles inline their assets
 * (fetched here, credentialed) so the opaque origin never makes a gated request,
 * while public bundles load assets back through this same route via an injected
 * `<base>`. Individual assets are still served with a strict `script-src 'none'`.
 *
 * Auth: baseApi({ auth: false }) so anonymous viewers can read public artifacts.
 * Two optional shims populate req.user for gated views: an Authorization: Bearer
 * JWT (optionalJwtAuth) and an X-API-Key (apiKeyAuth). A top-level browser
 * NAVIGATION carries neither, so for a gated bundle index with no credential we
 * return a small PUBLIC bootstrap shell (no secret) instead of 401; its inline
 * script reads the app's localStorage JWT and re-fetches this same route with
 * `?raw=1` + Authorization: Bearer, then injects the rendered srcdoc into the
 * sandboxed iframe client-side. The opaque-origin model is unchanged: the
 * bundle still runs in `sandbox="allow-scripts"` with NO allow-same-origin, the
 * token is read only by the trusted shell on the app origin (never the iframe),
 * and the visibility gate still runs for the HTML AND every asset. `?raw=1` is
 * served as inert text/plain so direct navigation can't execute it on the app origin.
 *
 * The loader shell is scoped to bundles. Gated reply/fabfile
 * snapshots are standalone top-level pages (working links, `script-src 'none'`, no iframe),
 * so browser-session viewing of a GATED reply/fabfile still requires a credential (-> 401);
 * the iframe-srcdoc model would change their sandboxing and break link navigation.
 */

const TIER_BY_PREFIX: Record<string, PublishScopeTier> = { u: 'user', pj: 'project', o: 'organization' };
// Bearer-JWT first (browser/client loader), then X-API-Key (programmatic). apiKeyAuth
// early-returns when req.user is already set, so the order lets Bearer win.
const optionalJwtShim = optionalJwtAuth();
const optionalAuthShim = apiKeyAuth();

// Anonymous `/a/<shareToken>` requests are the abuse/DoS surface for share links.
// Bound them per client (keyed by IP for anonymous viewers); a bundle load fans out
// into one request per asset, so the limit is generous. Fixed bucket (not the path)
// so every token shares one counter per client rather than one counter per token.
const SHARE_RATE_LIMIT_WINDOW_MS = 60_000;
const SHARE_RATE_LIMIT_MAX = 600;
const shareRateLimitShim = rateLimit({
  limit: SHARE_RATE_LIMIT_MAX,
  windowMs: SHARE_RATE_LIMIT_WINDOW_MS,
  bucket: 'publish-share-token',
});

/** Run an Express-style middleware as a promise; resolves on next(), rejects on next(err). */
function runShim(
  shim: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
  res: Response
): Promise<void> {
  let resolved = false;
  return new Promise<void>((resolve, reject) => {
    const next: NextFunction = (err?: unknown) => {
      resolved = true;
      if (err) return reject(err instanceof Error ? err : new Error(String(err)));
      resolve();
    };
    Promise.resolve(shim(req, res, next))
      .then(() => {
        if (!resolved) resolve();
      })
      .catch(reject);
  });
}

/** CSP for bundle ASSETS - `script-src 'none'` so an HTML/SVG asset can never
 *  execute JS on the app origin (the index path is validated + script-stripped
 *  separately; assets are not validated, so they get the strictest policy). */
// App origin for CSP allowlists, derived from the account-tied PUBLISH_HOST (SERVER_DOMAIN,
// no brand fallback). Empty when unconfigured, in which case 'self'/data: still cover
// same-origin assets and the cross-origin app host is simply not allowlisted.
const APP_HOST_SRC = PUBLISH_HOST ? `https://${PUBLISH_HOST}` : '';
// Brand-driven fallback for shared-artifact titles; neutral when APP_NAME is unset.
const SHARED_FALLBACK_TITLE = process.env.APP_NAME ? `Shared from ${process.env.APP_NAME}` : 'Shared';
const withAppHost = (base: string) => (APP_HOST_SRC ? `${base} ${APP_HOST_SRC}` : base);
const ASSET_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  withAppHost("style-src 'unsafe-inline'") + ' https://fonts.googleapis.com',
  withAppHost("img-src 'self' data:"),
  withAppHost("media-src 'self' data:"),
  withAppHost("font-src 'self'") + ' https://fonts.gstatic.com',
  "base-uri 'none'",
  "form-action 'none'",
  withAppHost("frame-ancestors 'self'"),
].join('; ');

interface ResolvedBundlePath {
  kind: 'bundle';
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  assetPath: string | null;
}
interface ResolvedShortPath {
  kind: 'reply' | 'fabfile';
  publicId: string;
}
interface ResolvedShareTokenPath {
  kind: 'share';
  shareToken: string;
  assetPath: string | null;
}
type ResolvedPath = ResolvedBundlePath | ResolvedShortPath | ResolvedShareTokenPath;

// Share links are served same-origin, sandboxed, and must never be cached: no-store
// is what makes a token rotation/revoke take effect immediately (no stale CDN/browser copy).
const SHARE_CACHE_CONTROL = 'private, no-store, must-revalidate';
// In-document belt-and-suspenders for the X-Robots-Tag / Referrer-Policy headers, for
// UAs that honor the <meta> but not the header (and vice versa).
const SHARE_NOINDEX_META =
  '<meta name="robots" content="noindex,nofollow">\n<meta name="referrer" content="no-referrer">';

const handler = baseApi({ auth: false }).get(async (req: Request, res: Response) => {
  // Optional-auth shims: a valid Authorization: Bearer JWT (optionalJwtShim) or
  // X-API-Key (optionalAuthShim) populates req.user; neither present passes through
  // anonymously; an INVALID X-API-Key short-circuits with 401 inside apiKeyAuth.
  await runShim(optionalJwtShim, req, res);
  if (res.headersSent) return;
  await runShim(optionalAuthShim, req, res);
  if (res.headersSent) return;

  const rawPath = req.query.path;
  const segments: string[] = Array.isArray(rawPath) ? rawPath.map(p => String(p)) : rawPath ? [String(rawPath)] : [];

  const resolved = parsePath(segments);
  if (!resolved) {
    return res.status(404).json({ error: 'Not found' });
  }

  // No-sign-in share link (`/a/<shareToken>`). Possession of the token IS the read
  // capability, so share links are served same-origin + sandboxed and the special
  // serve modes below - the loader shell, `?format=raw`, `?raw=1`, and the isolated
  // `/uc` origin - are ALL disabled: none of them should widen a token link's surface,
  // and the token must never leak into a `*.usercontent` Host.
  const isShare = resolved.kind === 'share';
  const shareToken = resolved.kind === 'share' ? resolved.shareToken : '';
  const shareAssetPath = resolved.kind === 'share' ? resolved.assetPath : null;

  // Rate-limit share links before touching the DB (throttled requests never query).
  // The shim rejects (via next(err)) once the bucket is full; map that to a 429 with
  // the Retry-After it already set.
  if (isShare) {
    try {
      await runShim(shareRateLimitShim, req, res);
    } catch {
      const retryAfter = res.getHeader('Retry-After');
      return res.status(429).json({ error: 'Too many requests', retryAfter });
    }
    if (res.headersSent) return;
  }

  // `?raw=1` is the authenticated re-fetch issued by the client-side loader shell:
  // it returns just the inner srcdoc (not the iframe wrapper) so the shell can inject it.
  // The visibility gate is UNCHANGED for raw requests - an unauthorized raw request still
  // 401/403s and NEVER falls back to the shell (that would loop the loader).
  const isRaw = !isShare && req.query.raw === '1';
  // `?format=raw` is the PUBLIC plain-text alternate advertised via `<link rel="alternate">`
  // on the wrapper. Distinct from `?raw=1`: format=raw exposes a stable text/plain view of the
  // artifact for agents/unfurlers/answer engines; raw=1 is the loader shell's internal
  // authenticated re-fetch. Only ever honored for artifacts with visibility === 'public'.
  const isFormatRaw = !isShare && req.query.format === 'raw';
  // Approach B: set by the `/uc/*` rewrite - this request is for the bundle on
  // its per-artifact isolated origin ({publicId}.usercontent.app.<domain>), served AS the page.
  const isIsolated = !isShare && req.query.__uc === '1';

  // Resolve the artifact.
  let artifact: PublishedArtifactLean | null = null;
  if (resolved.kind === 'share') {
    artifact = await PublishedArtifact.findOne({
      shareToken: resolved.shareToken,
      deletedAt: null,
    }).lean<PublishedArtifactLean>();
  } else if (resolved.kind === 'bundle') {
    artifact = await PublishedArtifact.findOne({
      tier: resolved.tier,
      scopeId: resolved.scopeId,
      slug: resolved.slug,
      deletedAt: null,
    }).lean<PublishedArtifactLean>();
  } else {
    artifact = await PublishedArtifact.findOne({
      publicId: resolved.publicId,
      'source.kind': resolved.kind,
      deletedAt: null,
    }).lean<PublishedArtifactLean>();
  }
  if (!artifact) {
    // Unknown OR revoked token -> plain 404 (never 401/403), so a prober can't
    // distinguish a revoked/never-existed token from a private artifact.
    return res.status(404).json({ error: 'Not found' });
  }

  // Access gate - runs on the HTML AND every asset request. Share links go through
  // checkShareGrant (token possession = read, even for a non-public artifact); every
  // other path uses the visibility-enum ladder. The two are mutually exclusive by kind.
  const access = isShare
    ? await checkShareGrant(artifact, { user: req.user as PublishUser | undefined })
    : await checkVisibility(artifact, req.user as PublishUser | undefined);
  if (!access.ok) {
    // Gated bundle INDEX navigated with NO credential -> return the PUBLIC client-side loader
    // shell instead of a hard 401. Its inline script reads the localStorage JWT and re-fetches
    // `?raw=1` with Authorization: Bearer. The discriminator is `!req.user` (no usable
    // credential on this request): re-fetching only helps when none was presented. A request
    // that DID carry a credential and still failed (403 - authed-but-unauthorized) re-fetches
    // to no avail, so it falls through to the hard status below. NOT for: assets (gated bundles
    // inline their assets, so the opaque iframe never requests them), `?raw=1` (the loader's
    // own fetch - a shell there would loop), or `?format=raw` (a plain-text API surface -
    // returning an HTML shell would violate the caller's Accept expectation, and format=raw
    // is public-only anyway, so we fall through to the visibility gate's hard status).
    const wantsLoaderShell = resolved.kind === 'bundle' && !resolved.assetPath && !isRaw && !isFormatRaw && !req.user;
    if (wantsLoaderShell) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', buildWrapperCsp(req));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Static shell - intentionally carries no artifact data (title/id), so an anonymous
      // viewer of a gated bundle learns nothing; the real title appears only once the
      // authenticated ?raw=1 srcdoc renders.
      return res.status(200).send(renderBundleLoaderShell());
    }
    return res.status(access.status).json({ error: access.error });
  }

  if (isShare) {
    // No-sign-in links are unlisted capabilities: keep them out of search indexes,
    // and stop the token leaking to third parties via the Referer header on any
    // outbound link the artifact author included. Set once here so every share
    // response below (viewer page, asset, wrapper) inherits them.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  // ── Reply / fabfile: render the snapshot body to a sanitized viewer page. ──
  if (artifact.source.kind === 'reply' || artifact.source.kind === 'fabfile') {
    if (isFormatRaw) {
      if (artifact.visibility !== 'public') {
        return res.status(404).json({ error: 'Not found' });
      }
      return sendRawArtifact(res, artifact, artifact.renderedBody ?? '');
    }
    const page = renderViewerPage(artifact, isShare);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // No scripts are needed for a rendered text/markdown page; 'none' neutralizes
    // any markup that slipped through, so this page can't execute injected JS.
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "script-src 'none'",
        "style-src 'unsafe-inline'",
        withAppHost("img-src 'self' data:"),
        "font-src 'self' https://fonts.gstatic.com",
        "base-uri 'self'",
        "form-action 'none'",
        "frame-ancestors 'self'",
      ].join('; ')
    );
    res.setHeader('Cache-Control', isShare ? SHARE_CACHE_CONTROL : cacheControlFor(artifact.visibility));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    bumpViewCount(artifact.publicId);
    return res.status(200).send(page);
  }

  // ?format=raw is a public-only surface; reject before touching storage on gated bundles
  // so a private artifact can never be pulled from S3 by a raw request (defense in depth on
  // top of the format=raw text-extraction gate later).
  if (isFormatRaw && artifact.visibility !== 'public') {
    return res.status(404).json({ error: 'Not found' });
  }

  // ── Bundle: serve HTML (asset rewrite + inline-script strip) or stream an asset. ──
  const storage = getPublishedArtifactsStorage();

  // Asset sub-path for a bundle, whether reached via `/p/...` or a `/a/<token>/...`
  // share link. Share bundles use the <base> asset model, so their assets re-enter
  // HERE carrying the token and are authorized by the same checkShareGrant above.
  const assetPath = resolved.kind === 'bundle' ? resolved.assetPath : shareAssetPath;
  if (assetPath) {
    const fileEntry = artifact.manifest.find(f => f.path === assetPath);
    if (!fileEntry) {
      return res.status(404).json({ error: 'Asset not in artifact manifest' });
    }
    try {
      const buf = await storage.download(`${artifact.storageKeyPrefix}${assetPath}`);
      res.setHeader('Content-Type', fileEntry.mimeType);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', isShare ? SHARE_CACHE_CONTROL : cacheControlFor(artifact.visibility));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // SECURITY: assets are served same-origin and validateBundle only vets
      // index.html - so an attacker could ship a second `evil.html` or `evil.svg`
      // with inline scripts. Enforce `script-src 'none'` on EVERY asset so HTML/SVG
      // assets can never execute JS on the app origin (css/img/fonts unaffected).
      res.setHeader('Content-Security-Policy', ASSET_CSP);
      return res.status(200).send(buf);
    } catch {
      return res.status(404).json({ error: 'Asset not found' });
    }
  }

  // Version selection (?v={sha}): serve a historical index from the archive when
  // the requested sha is a KNOWN version and not the current one. The sha must be
  // in the artifact's version list (prevents arbitrary archive reads). Only
  // index.html is versioned - assets resolve against the current manifest.
  // "Current" sha = the index anchor, or the latest history entry if the anchor is
  // missing (defensive - older rows may lack sha256Index). Comparing against this
  // prevents misclassifying ?v=<latest> as older and reading a non-existent
  // versions/<latest>.html (latest bytes live at index.html).
  const versionsList = artifact.versions ?? [];
  const currentSha = artifact.sha256Index ?? versionsList[versionsList.length - 1]?.sha256Index;
  const requestedVersion = typeof req.query.v === 'string' ? req.query.v : '';
  const isKnownOlderVersion =
    !!requestedVersion && requestedVersion !== currentSha && versionsList.some(v => v.sha256Index === requestedVersion);
  const indexKey = isKnownOlderVersion
    ? `${artifact.storageKeyPrefix}versions/${requestedVersion}.html`
    : `${artifact.storageKeyPrefix}index.html`;

  let indexHtml: string;
  try {
    indexHtml = (await storage.download(indexKey)).toString('utf-8');
  } catch {
    return res.status(isKnownOlderVersion ? 404 : 500).json({
      error: isKnownOlderVersion ? 'Version not found' : 'Artifact index.html missing from storage',
    });
  }

  if (isFormatRaw) {
    if (artifact.visibility !== 'public') {
      return res.status(404).json({ error: 'Not found' });
    }
    return sendRawArtifact(res, artifact, stripToText(indexHtml, 50000));
  }

  // Approach B: on the per-artifact isolated origin the bundle is served at a
  // DISTINCT path (`/uc/...`) so the CDN can't collide the app-origin wrapper with the
  // isolated bundle even on a cache policy that doesn't key on Host. Assets resolve
  // against this same base, so they stay on the isolated origin too.
  const canonicalPath = buildPublishUrlPath(artifact.tier, artifact.scopeId, artifact.slug); // /p/{prefix}/{scope}/{slug}
  const isolatedPath = canonicalPath.replace(/^\/p\b/, '/uc');
  // Share bundles resolve their <base>-relative assets back through `/a/<token>/...`
  // (self-authorized by the token); /p uses the canonical path (or isolated /uc path).
  const shareBase = isShare ? `/a/${encodeURIComponent(shareToken)}` : '';
  const urlBase = isShare ? shareBase : isIsolated ? isolatedPath : canonicalPath;

  // Document origin the sandboxed bundle resolves absolute URLs against (blessed libs, the
  // public-tier <base>). resolveDocOrigin treats Host / X-Forwarded-Proto as untrusted: it
  // format-validates AND allowlists the host, so a crafted `Host: attacker.com`
  // can't mint a CSP whitelisting attacker.com - it falls back to the app host.
  const docOrigin = resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']);

  // Gated (non-public) bundles: the opaque-origin iframe can't fetch assets through the
  // gated route (uncredentialed -> 401/403), so pre-fetch them HERE (post-gate, credentialed)
  // and inline them. Public bundles load assets back through this route via an injected <base>.
  // Share links use the <base> asset model (assets self-authorize via the token), so
  // they never inline - only gated `/p` bundles pre-fetch + inline their assets here.
  let inlineAssets: Map<string, SandboxAsset> | undefined;
  let droppedAssets: string[] = [];
  if (!isShare && artifact.visibility !== 'public') {
    const collected = await collectInlineAssets({
      manifest: artifact.manifest,
      load: path => storage.download(`${artifact.storageKeyPrefix}${path}`),
    });
    inlineAssets = collected.assets;
    droppedAssets = [...collected.oversized, ...collected.failed];
  }

  const { srcdoc: baseSrcdoc } = renderSandboxedBundle({
    indexHtml,
    urlBase,
    origin: docOrigin,
    visibility: artifact.visibility,
    assetMode: isShare ? 'base' : undefined,
    assets: inlineAssets,
  });

  // Comment-pin bridge: when comments are enabled, inject a tiny trusted script INTO the
  // sandboxed bundle so pin-drop works over the iframe. Clicks over the iframe are consumed
  // by its own document, never reaching the parent overlay - so the bridge captures the
  // pin-drop click inside the iframe and postMessages the coords up to the wrapper widget,
  // and renders existing pin markers inside the bundle doc (scroll-correct). It exchanges
  // only non-sensitive UI data with the parent; it cannot read the app token (opaque origin).
  const commentsEnabled = !!artifact.commentPolicy && artifact.commentPolicy !== 'none';
  const srcdoc = commentsEnabled ? injectPinBridge(baseSrcdoc) : baseSrcdoc;

  if (droppedAssets.length) {
    // No silent truncation - surface skipped assets to operators and reviewers, both the
    // count and the names (truncated to keep the header well under typical 8KB limits).
    console.warn(
      `[publish] bundle ${artifact.publicId} dropped ${droppedAssets.length} oversized/failed asset(s):`,
      droppedAssets
    );
    res.setHeader('X-Publish-Dropped-Assets', String(droppedAssets.length));
    res.setHeader('X-Publish-Dropped-Asset-Names', truncateHeaderList(droppedAssets, 1024));
  }

  // Raw mode: return ONLY the inner srcdoc for the loader shell to inject. Served as
  // inert text/plain + nosniff so a DIRECT navigation to `?raw=1` renders source text and
  // cannot execute on the app origin; `sandbox` in the CSP forces an opaque origin with no
  // script execution were a UA to ignore nosniff. fetch().text() is unaffected by either.
  if (isRaw) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    bumpViewCount(artifact.publicId);
    return res.status(200).send(srcdoc);
  }

  // `?v={sha}` historical views are a cold path served `no-store` (removes the
  // dependency on whether the CDN keys on the `v` query string).
  const bundleCacheControl = isShare
    ? SHARE_CACHE_CONTROL
    : isKnownOlderVersion
      ? 'private, no-store'
      : cacheControlFor(artifact.visibility);

  // The per-artifact isolated origin (Approach B), e.g. `abc123.usercontent.app.<domain>`.
  // Empty when SERVER_DOMAIN is unset (Approach B disabled) OR the artifact is non-public:
  // GATED bundles keep the same-origin sandboxed-srcdoc model (Approach A) because a
  // cross-origin iframe can't carry the viewer's app credentials to load a gated bundle
  // (and the app-origin handler is where the gated assets get inlined post-auth).
  // Share links stay on the same-origin sandboxed-srcdoc model (Approach A): never the
  // per-artifact isolated origin, so the token can't leak into a `*.usercontent` Host.
  const artifactHost = !isShare && artifact.visibility === 'public' ? usercontentHostFor(artifact.publicId) : '';

  // ── Approach B: serve the bundle AS the page on its isolated origin. ──
  // Reached via the `/uc/*` rewrite on `{publicId}.usercontent.app.<domain>`. The bundle runs
  // as a TRUE separate origin (its own SOP partition) - author inline JS executes, but it
  // cannot read the APP origin's localStorage/token (different origin). We validate the
  // host's publicId matches this artifact so one artifact's subdomain can't serve another's.
  if (isIsolated) {
    if (!artifactHost || publicIdFromUsercontentHost(req.headers.host) !== artifact.publicId) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', buildIsolatedBundleCsp(req));
    res.setHeader('Cache-Control', bundleCacheControl);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // No bumpViewCount here: the isolated bundle is loaded as a sub-resource of the
    // app-origin wrapper, which already counts the view. Counting here too would
    // double every view; a rare direct hit on the /uc URL goes uncounted (acceptable
    // undercount vs systematic 2x). View count is best-effort/non-authoritative anyway.
    return res.status(200).send(srcdoc);
  }

  // ── App origin: the trusted WRAPPER page (comment overlay reads the token here). ──
  // Approach B -> embed the bundle via a CROSS-ORIGIN `<iframe src={isolatedSrc}>` (the
  // isolated origin provides the isolation; `allow-same-origin` there is safe because it
  // resolves to the usercontent origin, NOT the app origin -> no ATO). Gated on
  // isAppWrapperHost: only stages that PROVISION the `*.usercontent` alias serve the app at
  // `app.<domain>`, so if this wrapper is served from any other host (e.g. shared-dev's
  // `files.dev.<domain>`, which has no usercontent alias) we fall back to the same-origin
  // `sandbox="allow-scripts"` srcdoc model rather than point an iframe at an unprovisioned
  // (403-ing) host. SERVER_DOMAIN unset (local/dev/forks) -> artifactHost empty -> same fallback.
  const useIsolatedEmbed = !!artifactHost && isAppWrapperHost(req.headers.host);
  const isolatedSrc = useIsolatedEmbed
    ? `https://${artifactHost}${isolatedPath}${requestedVersion ? `?v=${encodeURIComponent(requestedVersion)}` : ''}`
    : '';
  // Public shares emit full server-rendered meta + a noscript body + a link to the
  // raw plain-text variant so unfurlers, LLM URL fetchers, and non-JS crawlers see
  // more than the JS shell. Gated shares deliberately do not: the loader shell must
  // carry no artifact data pre-auth.
  const shareMeta =
    !isShare && artifact.visibility === 'public'
      ? prepareShareMeta({
          title: artifact.title || SHARED_FALLBACK_TITLE,
          description: artifact.description,
          bodyForExcerpt: indexHtml,
          canonicalUrl: `${docOrigin}${canonicalPath}`,
          rawUrl: `${docOrigin}${canonicalPath}?format=raw`,
          siteName: process.env.APP_NAME || '',
        })
      : null;
  const wrapperPage = renderBundleWrapper(artifact, srcdoc, requestedVersion, isolatedSrc, shareMeta, isShare);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', buildWrapperCsp(req, isolatedSrc ? artifactHost : ''));
  res.setHeader('Cache-Control', bundleCacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  bumpViewCount(artifact.publicId);
  return res.status(200).send(wrapperPage);
});

/**
 * Minimal trusted wrapper page hosting the bundle in an iframe. Runs no script of
 * its own (besides the comment overlay). Two isolation modes:
 *   - Approach B (`isolatedSrc` set): a CROSS-ORIGIN `<iframe src={isolatedSrc}>` to
 *     `{publicId}.usercontent.app.<domain>`. The separate origin is the isolation boundary;
 *     `allow-same-origin` is SAFE here (resolves to the usercontent origin, not the app).
 *   - Fallback (no isolatedSrc - SERVER_DOMAIN unset): the same-origin sandboxed
 *     `srcdoc` model - `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (opaque
 *     origin; NEVER add allow-same-origin here - it would reclaim the app origin -> ATO).
 */
function renderBundleWrapper(
  artifact: PublishedArtifactLean,
  srcdoc: string,
  requestedVersion: string,
  isolatedSrc: string,
  shareMeta: { metaTags: string; noscriptBody: string; alternateLink: string } | null,
  noindex: boolean
): string {
  const titleHtml = escapeHtml(artifact.title || SHARED_FALLBACK_TITLE);
  // HTML attribute escape: inside a double-quoted attribute value only `&` and `"` are
  // unsafe - `<`/`>` are literal data here. Do NOT add them: the srcdoc already contains
  // escaped entities (e.g. `&lt;`), and re-escaping `&` after adding `<`/`>` would corrupt
  // the framed document. Order matters - `&` first so it doesn't double-escape the `&quot;`.
  const srcdocAttr = srcdoc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Approach B: cross-origin src. `allow-same-origin` is REQUIRED (and safe) here - it keeps
  // the framed doc on its usercontent origin (isolated from the app by SOP), which is what
  // lets the bundle load its own `<base>`-relative assets same-origin. The sandbox is kept
  // minimal otherwise: NO allow-forms (the isolated CSP sets `form-action 'none'`, so it'd be
  // dead capability) and NO allow-popups (matches the Approach A `allow-scripts`-only posture).
  // Fallback: opaque-origin srcdoc (no allow-same-origin - that would reclaim the app origin).
  const iframeTag = isolatedSrc
    ? `<iframe sandbox="allow-scripts allow-same-origin" title="${titleHtml}" src="${escapeHtml(isolatedSrc)}"></iframe>`
    : `<iframe sandbox="allow-scripts" title="${titleHtml}" srcdoc="${srcdocAttr}"></iframe>`;
  // The comment overlay lives in this trusted wrapper (app origin), floating over the
  // sandboxed iframe - never inside it (the opaque-origin bundle can't read the token).
  const overlay = buildAnnotateOverlayHtml(artifact);
  // Abuse-report affordance: a plain anchor floats over the iframe. It is a
  // top-level navigation (not blocked by the wrapper's script-src/form-action CSP) to
  // the app-origin report flow. The bundle in the opaque-origin iframe can't reach it.
  const reportHref = `/report/${encodeURIComponent(artifact.publicId)}`;
  const versionBar = buildVersionSwitcherHtml(artifact, requestedVersion);
  const metaHead = shareMeta ? `\n${shareMeta.metaTags}\n${shareMeta.alternateLink}` : '';
  const noindexHead = noindex ? `\n${SHARE_NOINDEX_META}` : '';
  const noscriptBody = shareMeta ? `\n${shareMeta.noscriptBody}` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${noindexHead}
<title>${titleHtml}</title>${metaHead}
<style>html,body{margin:0;padding:0;height:100%}iframe{border:0;display:block;width:100%;height:100vh}
.b4m-report{position:fixed;bottom:10px;right:10px;z-index:2147483647;font:500 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;
  color:#cbd5e1;background:rgba(13,24,48,.78);padding:5px 9px;border-radius:8px;text-decoration:none;backdrop-filter:blur(4px)}
.b4m-report:hover{color:#fff;background:rgba(13,24,48,.95)}
.b4m-ver{position:fixed;bottom:10px;left:10px;z-index:2147483647;display:flex;align-items:center;gap:8px;
  font:500 11px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#cbd5e1;background:rgba(13,24,48,.78);
  padding:5px 9px;border-radius:8px;backdrop-filter:blur(4px)}
.b4m-ver a{color:#8ab4ff;text-decoration:none;font-weight:600}
.b4m-ver .b4m-vd{opacity:.4}</style>
</head>
<body>
${iframeTag}
${overlay}
${versionBar}
<a class="b4m-report" href="${reportHref}" rel="nofollow" target="_top">⚑ Report</a>
${noscriptBody}
</body>
</html>`;
}

/**
 * Version switcher (shown only when >1 version). Plain top-level-navigation
 * anchors to `?v={sha}` (latest drops the param) - no script, matching the
 * report affordance. Only index.html is versioned; assets stay current.
 */
function buildVersionSwitcherHtml(artifact: PublishedArtifactLean, requestedVersion: string): string {
  // Dedup by sha at read time (keep first occurrence / order). The write-side
  // dedup isn't concurrency-safe - two concurrent finalizes (finalize takes no
  // revise lock) could push the same sha twice - so collapsing here keeps the
  // ordinal math and the prev/next/latest links correct regardless.
  const seen = new Set<string>();
  const versions = (artifact.versions ?? []).filter(v => {
    if (seen.has(v.sha256Index)) return false;
    seen.add(v.sha256Index);
    return true;
  });
  if (versions.length < 2) return '';
  const latestSha = versions[versions.length - 1].sha256Index;
  const currentSha = requestedVersion || artifact.sha256Index || latestSha;
  const idxRaw = versions.findIndex(v => v.sha256Index === currentSha);
  const idx = idxRaw === -1 ? versions.length - 1 : idxRaw;
  const base = buildPublishUrlPath(artifact.tier, artifact.scopeId, artifact.slug);
  const hrefFor = (sha: string) => escapeHtml(sha === latestSha ? base : `${base}?v=${encodeURIComponent(sha)}`);
  const link = (sha: string | undefined, label: string) =>
    sha ? `<a target="_top" href="${hrefFor(sha)}">${label}</a>` : `<span class="b4m-vd">${label}</span>`;
  const prev = idx > 0 ? versions[idx - 1].sha256Index : undefined;
  const next = idx < versions.length - 1 ? versions[idx + 1].sha256Index : undefined;
  const latestTag = idx === versions.length - 1 ? ' (latest)' : '';
  return (
    `<div class="b4m-ver">` +
    link(prev, '◀') +
    `<span>v${idx + 1} of ${versions.length}${latestTag}</span>` +
    link(next, '▶') +
    (latestTag ? '' : ` ${link(latestSha, 'latest')}`) +
    `</div>`
  );
}

/**
 * CSP for the bundle wrapper AND the public loader shell. A `srcdoc` iframe INHERITS the
 * embedder's CSP (HTML spec: about:srcdoc documents inherit the parent policy and can only
 * further restrict it via their own <meta>), so this single header must permit what the
 * BUNDLE needs (inline scripts + the blessed libs + app-origin/data: assets + the public-tier
 * <base>), not just the wrapper. That is safe: the wrapper/shell are fully server-generated
 * with no injection vector, and the opaque sandbox origin - not this CSP - is the ATO boundary.
 * The values derive only from the (allowlisted) Host/proto headers - no credentials - so the
 * shell (returned pre-gate for a no-credential navigation) can reuse the same policy.
 */
/**
 * CSP for the bundle served on its ISOLATED per-artifact origin (Approach B). Author inline
 * JS is ALLOWED here - the isolation boundary is the separate origin (its own SOP partition,
 * no access to the app token), NOT script-stripping. `'self'` is the usercontent origin, so
 * the bundle's own assets + inline scripts run; blessed libs load from the app host. connect-src
 * is restricted to 'self' (the bundle has no app credentials, but we still bound beaconing).
 * frame-ancestors permits ONLY the exact app host that renders the wrapper - `app.<domain>`
 * (PUBLISH_HOST). It intentionally uses NO wildcard: the isolated origins are
 * nested under the app host (`*.usercontent.app.<domain>`), so a `*.app.<domain>` source would
 * SUFFIX-MATCH every bundle host (CSP host wildcards match any subdomain depth), re-permitting
 * bundle-on-bundle clickjacking. An exact host can't match a bundle origin, so one published
 * bundle can never frame another. If a deployment ever serves the wrapper from additional
 * hosts, enumerate them here explicitly rather than reintroducing a wildcard.
 */
function buildIsolatedBundleCsp(req: Request): string {
  const appHost = PUBLISH_HOST ? `https://${PUBLISH_HOST}` : '';
  const appHostSrc = appHost ? ` ${appHost}` : '';
  const blessedScriptSrc = buildBundleScriptSrc(req.headers.host, req.headers['x-forwarded-proto']);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'self' ${blessedScriptSrc}`,
    `style-src 'unsafe-inline' 'self'${appHostSrc} https://fonts.googleapis.com`,
    `img-src 'self' data:${appHostSrc}`,
    `media-src 'self' data:${appHostSrc}`,
    `font-src 'self' data:${appHostSrc} https://fonts.gstatic.com`,
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    appHost ? `frame-ancestors ${appHost}` : "frame-ancestors 'self'",
  ].join('; ');
}

function buildWrapperCsp(req: Request, artifactHost?: string): string {
  const docOrigin = resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']);
  // Approach B: the wrapper embeds the bundle via a cross-origin iframe to the artifact's
  // isolated host, so frame-src must permit it. Only the exact per-artifact host is added.
  const frameSrc = artifactHost ? `frame-src 'self' https://${artifactHost}` : "frame-src 'self'";
  // App host derived from PUBLISH_HOST (SERVER_DOMAIN, no brand fallback). Empty when
  // unconfigured; `appHostSrc` then contributes nothing rather than a bare `https://` token.
  const appHost = PUBLISH_HOST ? `https://${PUBLISH_HOST}` : '';
  const appHostSrc = appHost ? ` ${appHost}` : '';
  // blessed libs at both the document origin and the canonical app host.
  const blessedScriptSrc = buildBundleScriptSrc(req.headers.host, req.headers['x-forwarded-proto']);
  // The trusted comment-overlay widget loads from /api/publish/widget on the app origin
  // (and doc origin for preview/staging hosts). Allowlisted explicitly - it runs in the
  // wrapper (parent), never the sandboxed bundle. The app-host variant is added only when
  // PUBLISH_HOST is configured.
  const widgetSrc = `${docOrigin}/api/publish/widget${appHost ? ` ${appHost}/api/publish/widget` : ''}`;
  // script-src: in Approach B (artifactHost set) the bundle runs on its OWN cross-origin
  // iframe, so the wrapper carries NO inline scripts and NO bundle libs - tighten to just the
  // external widget (drop 'unsafe-inline' + blessed libs -> smaller XSS blast radius). In the
  // srcdoc fallback (and the loader shell, which passes no artifactHost) the bundle inherits
  // this CSP, so it must still permit the bundle's inline scripts + blessed libs.
  const scriptSrc = artifactHost ? widgetSrc : `'unsafe-inline' ${blessedScriptSrc} ${widgetSrc}`;
  return [
    "default-src 'none'",
    frameSrc,
    `script-src ${scriptSrc}`,
    `style-src 'unsafe-inline' ${docOrigin}${appHostSrc} https://fonts.googleapis.com`,
    `img-src data: ${docOrigin}${appHostSrc}`,
    `media-src data: ${docOrigin}${appHostSrc}`,
    `font-src data: ${docOrigin}${appHostSrc} https://fonts.gstatic.com`,
    `connect-src ${docOrigin}${appHostSrc}`,
    `base-uri ${docOrigin}${appHostSrc}`,
    "form-action 'none'",
    // App host derived from PUBLISH_HOST; 'self' alone when unconfigured.
    PUBLISH_HOST ? `frame-ancestors 'self' ${appHost}` : "frame-ancestors 'self'",
  ].join('; ');
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface PublishedArtifactLean {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  title: string;
  description?: string;
  visibility: PublishVisibility;
  commentPolicy?: 'none' | 'open' | 'restricted';
  ownerId: string;
  storageKeyPrefix: string;
  manifest: Array<{ path: string; mimeType: string }>;
  renderedBody?: string;
  source: { kind: 'bundle' | 'reply' | 'fabfile' };
  sha256Index?: string;
  versions?: Array<{ sha256Index: string }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function parsePath(segments: string[]): ResolvedPath | null {
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

/** Join paths into a comma-separated header value, capped at maxLen chars (adds a `...(+N)` tail). */
function truncateHeaderList(paths: string[], maxLen: number): string {
  const full = paths.join(', ');
  if (full.length <= maxLen) return full;
  const kept: string[] = [];
  let len = 0;
  for (let i = 0; i < paths.length; i++) {
    const add = (kept.length ? 2 : 0) + paths[i].length;
    if (len + add > maxLen - 16) break; // reserve room for the `…(+N more)` tail
    kept.push(paths[i]);
    len += add;
  }
  return `${kept.join(', ')} …(+${paths.length - kept.length} more)`;
}

function cacheControlFor(visibility: PublishVisibility): string {
  // Public pages stay cacheable for performance. Immediacy on removal comes from
  // an explicit CloudFront invalidation (takedown / delete / visibility-downgrade
  // call invalidatePublishCdn), so the shared cache can keep a long s-maxage. We
  // still DROP stale-while-revalidate (the old `=86400` let a removed page serve
  // stale for a day) and keep the per-viewer browser window short (max-age=60) as
  // the backstop if an invalidation is ever skipped/throttled.
  if (visibility === 'public') return 'public, max-age=60, s-maxage=3600';
  return 'private, no-store, must-revalidate';
}

/** Best-effort, non-authoritative view counter. Never blocks the response. */
function bumpViewCount(publicId: string): void {
  void PublishedArtifact.updateOne({ publicId }, { $inc: { viewCount: 1 } }).catch(() => undefined);
}

/**
 * Serve a plain-text alternate for a public artifact (?format=raw). Author-supplied text is
 * inert as text/plain, but we still emit `default-src 'none'; sandbox` + nosniff so a UA
 * that ignored the type couldn't parse it as HTML on the app origin. Callers must gate on
 * `visibility === 'public'` and pass the already-plain body (post-HTML-strip for bundles,
 * as-is for reply/fabfile renderedBody).
 */
function sendRawArtifact(res: Response, artifact: PublishedArtifactLean, body: string): void {
  const title = artifact.title || SHARED_FALLBACK_TITLE;
  const description = artifact.description?.trim();
  const parts = [`# ${title}`];
  if (description) parts.push('', description);
  const trimmedBody = body.trim();
  if (trimmedBody) parts.push('', trimmedBody);
  const content = parts.join('\n') + '\n';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControlFor('public'));
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  bumpViewCount(artifact.publicId);
  res.status(200).send(content);
}

/**
 * Render a reply/fabfile snapshot to a standalone HTML page. Replies are
 * markdown (rendered via marked); fabfiles render as escaped <pre>. Served with
 * script-src 'none' so injected markup cannot execute.
 */
function renderViewerPage(artifact: PublishedArtifactLean, noindex: boolean): string {
  const body = artifact.renderedBody ?? '';
  const titleHtml = escapeHtml(artifact.title || SHARED_FALLBACK_TITLE);
  const contentHtml =
    artifact.source.kind === 'reply'
      ? sanitizeRenderedHtml(marked.parse(body, { async: false }) as string)
      : `<pre class="b4m-pre">${escapeHtml(body)}</pre>`;
  const noindexHead = noindex ? `\n${SHARE_NOINDEX_META}` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${noindexHead}
<meta property="og:title" content="${titleHtml}">
<meta property="og:description" content="${escapeHtml(SHARED_FALLBACK_TITLE)}">
<title>${titleHtml}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.6;
         max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; color: #1a1a2e; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6e6f0; background: #0f0f1a; } a { color: #8ab4ff; } }
  h1, h2, h3 { line-height: 1.25; }
  pre.b4m-pre, pre { background: rgba(127,127,127,.12); padding: 1rem; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; }
  code { background: rgba(127,127,127,.15); padding: .15em .35em; border-radius: 4px; }
  img { max-width: 100%; height: auto; }
  .b4m-footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid rgba(127,127,127,.3); font-size: .85rem; opacity: .7; }
</style>
</head>
<body>
<article>${contentHtml}</article>
${buildShareFooterHtml({
  source: artifact.source.kind === 'reply' ? 'reply' : 'fabfile',
  reportPublicId: artifact.publicId,
})}
</body>
</html>`;
}

/**
 * Build the comment-overlay mount node + trusted widget script tag, injected into
 * the WRAPPER page (app origin) - config passed via data-* attributes. Returns ''
 * when commentPolicy is `none` so opt-out artifacts get no widget. escapeHtml is
 * shared from viewerSecurity.
 */
/**
 * Trusted pin-bridge script injected INTO the sandboxed bundle (the iframe srcdoc) when
 * comments are enabled. It runs on the opaque origin - it cannot read the app token - and
 * only exchanges UI messages with the parent wrapper widget:
 *   parent -> iframe : { b4m:'pinmode', on } | { b4m:'pins', pins:[{id,x,y,pending}] } | { b4m:'scrollto', y }
 *   (GEOMETRY ONLY - never comment text/author: the iframe runs untrusted author JS)
 *   iframe -> parent : { b4m:'ready' } | { b4m:'pin-dropped', x, y } | { b4m:'pin-activate', id }
 * Coords are normalized 0..1 against the bundle document's scroll size. Both sides validate
 * the message source AND origin (parent <-> iframe). In Approach B the iframe is a TRUE
 * cross-origin frame, so the bridge pins its parent's origin from `document.referrer` (the
 * embedding wrapper, trimmed to origin under the default cross-origin referrer policy) and
 * uses it as the postMessage targetOrigin + an inbound `event.origin` allowlist. In the
 * same-origin srcdoc fallback (Approach A) the sandboxed doc has no referrer -> PO stays '*'
 * (target opaque origin) and the origin check is skipped, leaving the source check as before.
 * Contains no `</script>` so it can't break out of the tag.
 */
const PIN_BRIDGE_JS = String.raw`(function(){
  'use strict';
  var pinMode=false,pins=[],layer=null;
  var PO=(function(){try{return document.referrer?new URL(document.referrer).origin:'*';}catch(e){return '*';}})();
  function L(){if(!layer){layer=document.createElement('div');layer.style.cssText='position:absolute;top:0;left:0;width:0;height:0;z-index:2147482000;pointer-events:none';(document.body||document.documentElement).appendChild(layer);}return layer;}
  function W(){return Math.max(document.documentElement.scrollWidth,document.documentElement.clientWidth);}
  function H(){return Math.max(document.documentElement.scrollHeight,document.documentElement.clientHeight);}
  function post(m){try{parent.postMessage(m,PO);}catch(e){}}
  function setMode(on){pinMode=on;var c=on?'crosshair':'';document.documentElement.style.cursor=c;if(document.body){document.body.style.cursor=c;}}
  function draw(){var l=L();l.textContent='';pins.forEach(function(p){if(typeof p.x!=='number'||typeof p.y!=='number'){return;}var m=document.createElement('div');m.style.cssText='position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;pointer-events:auto;background:'+(p.pending?'#e0a800':'#3949d4');m.style.left=(p.x*W())+'px';m.style.top=(p.y*H())+'px';m.addEventListener('click',function(e){e.stopPropagation();post({b4m:'pin-activate',id:p.id});});l.appendChild(m);});}
  document.addEventListener('click',function(e){if(!pinMode){return;}e.preventDefault();e.stopPropagation();var x=e.pageX/W(),y=e.pageY/H();setMode(false);post({b4m:'pin-dropped',x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))});},true);
  window.addEventListener('message',function(e){if(e.source!==window.parent){return;}if(PO!=='*'&&e.origin!==PO){return;}var d=e.data||{};if(d.b4m==='pinmode'){setMode(!!d.on);}else if(d.b4m==='pins'){pins=Array.isArray(d.pins)?d.pins:[];draw();}else if(d.b4m==='scrollto'&&typeof d.y==='number'){window.scrollTo({top:d.y*H()-window.innerHeight/2,behavior:'smooth'});}});
  window.addEventListener('resize',draw);
  post({b4m:'ready'});
})();`;

/** Inject the pin bridge as an inline <script> at the end of the bundle body (before </body>
 *  if present, else appended). Allowed by the wrapper CSP's `script-src 'unsafe-inline'`. */
function injectPinBridge(srcdoc: string): string {
  const tag = `<script>${PIN_BRIDGE_JS}</script>`;
  return /<\/body>/i.test(srcdoc) ? srcdoc.replace(/<\/body>/i, `${tag}</body>`) : srcdoc + tag;
}

function buildAnnotateOverlayHtml(artifact: PublishedArtifactLean): string {
  if (!artifact.commentPolicy || artifact.commentPolicy === 'none') return '';
  const publicId = escapeHtml(artifact.publicId);
  const policy = escapeHtml(artifact.commentPolicy);
  const title = escapeHtml(artifact.title || '');
  return (
    `<div id="b4m-annotate-root" data-public-id="${publicId}" ` +
    `data-comment-policy="${policy}" data-title="${title}"></div>` +
    `<script src="/api/publish/widget" defer></script>`
  );
}

export const config = {
  api: {
    externalResolver: true,
    responseLimit: '15mb',
  },
};

export default handler;
