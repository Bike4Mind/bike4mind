import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Blocks path traversal and null-byte injection before reaching the ISR cache layer (#7190)
const PATH_TRAVERSAL_PATTERN = /(\.\.[/\\])|([/\\]\.\.)|(\.\.%2[fF])|(%2[fF]\.\.)/;
const NULL_BYTE_PATTERN = /%00|\0/;
const BACKSLASH_PATTERN = /\\/;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const rawUrl = request.url;

  if (
    PATH_TRAVERSAL_PATTERN.test(pathname) ||
    PATH_TRAVERSAL_PATTERN.test(rawUrl) ||
    NULL_BYTE_PATTERN.test(pathname) ||
    NULL_BYTE_PATTERN.test(rawUrl) ||
    BACKSLASH_PATTERN.test(pathname)
  ) {
    console.warn(
      `[SECURITY] Blocked path traversal attempt: ${request.method} ${pathname} from ${request.headers.get('x-forwarded-for') || 'unknown'}`
    );
    return new NextResponse('Bad Request', { status: 400 });
  }

  // Block malformed URL encoding before Next.js route matcher throws DecodeError.
  // The route matcher calls decodeURIComponent() on each extracted path param. Paths
  // containing sequences like %25 (encoded %) decode to bare % signs which, if followed
  // by non-hex characters, cause a URIError. We simulate a double-decode to proactively
  // catch these cases: if decoding the pathname and then decoding the result throws,
  // the URL is malformed and should be rejected.
  try {
    const decoded = decodeURIComponent(pathname);
    decodeURIComponent(decoded);
  } catch {
    console.warn(
      `[SECURITY] Blocked malformed URL encoding: ${request.method} ${pathname} from ${request.headers.get('x-forwarded-for') || 'unknown'}`
    );
    return new NextResponse('Bad Request', { status: 400 });
  }

  // Clone the response headers for all routes
  const response = NextResponse.next();

  // Define Content Security Policy
  // blob: is required by Voice v2 (ElevenLabs Conversational AI loads its
  // AudioWorklet processors from blob: URLs at runtime). It must be on script-src,
  // NOT worker-src: per CSP, Worklet module scripts (incl. AudioWorklet.addModule)
  // are governed by script-src — worklets are script execution contexts, not
  // Workers — so worker-src blob: alone does not cover them. Without script-src
  // blob: the worklet load is refused and the voice call cannot start.
  // Note: both HTML and React artifact iframes now load from Next.js API routes
  // (/api/artifact-sandbox and /api/react-artifact-sandbox, #9403) that set their OWN
  // per-response CSP, rather than blob: URLs. Chrome applies the blob creator's CSP to
  // blob-URL iframe content, which previously forced https: into the global style-src;
  // routing both artifact types through real routes removes that coupling, so the global
  // style-src no longer needs the blanket https: wildcard.
  // 'unsafe-inline' remains in BOTH script-src and style-src. Nonce-based CSP is not
  // viable in this architecture: the SPA shell is statically prerendered (force-static in
  // app/layout.tsx and app/[[...slug]]/page.tsx) and served from the CDN cache, so this
  // middleware can set a per-request nonce header but cannot stamp that nonce into the
  // already-cached static HTML body. MUI Joy (Emotion) also injects <style> tags at
  // runtime as components mount, which build-time hashes cannot enumerate or cover.
  // Removing 'unsafe-inline' would require rendering the shell per-request (losing the
  // CDN full-page cache and adding Lambda latency on the hottest path) just to close the
  // lower-severity style-src gap while script-src inline would remain.
  // Decision (#8628): accepted risk. Exploiting style-src inline requires a separate
  // HTML-injection sink, and the high-value CSP controls are already in place
  // (object-src 'none', base-uri 'self', frame-ancestors 'self', form-action 'self',
  // scoped host allowlists rather than blanket wildcards). #8512 was the prior CSP
  // hardening pass (removed 'unsafe-eval' + blanket https:). Revisit only if the shell
  // moves to per-request dynamic rendering, at which point fix script-src and style-src
  // together via a single nonce wired through AppRouterCacheProvider (Emotion cache).
  // Next.js/Turbopack dev mode compiles + evaluates modules via eval() (HMR + React
  // debug callstacks), so 'unsafe-eval' is required for local `sst dev` / `next dev`.
  // Without it the SPA shell's CSP blocks eval → React dev breaks → e.g. post-login
  // client handling fails ("Sign-in couldn't complete"). NEVER in prod — the #8512
  // hardening pass deliberately removed 'unsafe-eval' from the built CSP; this re-adds
  // it ONLY when NODE_ENV === 'development' (not 'production', not 'test').
  const devUnsafeEval = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  // Reddit ads pixel (consent-deferred, see app/utils/redditPixel.ts): script from
  // www.redditstatic.com, pixel config fetch from pixel-config.reddit.com, and the
  // conversion beacon (rp.gif) to alb.reddit.com — the latter goes in both img-src
  // and connect-src since the pixel may use either transport.
  const scriptSrcPolicy = `'self' 'unsafe-inline'${devUnsafeEval} blob: https://unpkg.com https://cdn.tailwindcss.com https://assets.mailerlite.com https://accounts.google.com https://js.stripe.com https://apis.google.com https://cdn.jsdelivr.net https://www.googletagmanager.com https://www.redditstatic.com`;
  // assets.mailerlite.com hosts universal.css for the in-app subscriber widget; explicit host avoids re-opening blanket https:.
  const styleSrcPolicy = `'self' 'unsafe-inline' https://assets.mailerlite.com`;

  // Deployment's own files subdomain for CSP, derived from the account-tied SERVER_DOMAIN with
  // no brand fallback (#9310/#9306); empty when unconfigured.
  const filesHost = process.env.SERVER_DOMAIN ? ` https://files.dev.${process.env.SERVER_DOMAIN}` : '';

  // Operator blog host for the optional blog-integration feature, driven by the same
  // NEXT_PUBLIC_BLOG_HOST config the client uses (open-core #9392); no brand fallback, empty
  // when unconfigured so a fork's CSP never allow-lists a personal blog domain. Removing this
  // would block the blog image-upload/presign requests, so it must track the configured host.
  //
  // Defense-in-depth: NEXT_PUBLIC_BLOG_HOST is an operator-controlled build-time repo variable
  // (not user input), but a malformed value (whitespace or a literal ';') would inject extra
  // CSP directives. Validate it parses as a single https origin and normalize to `url.origin`
  // (scheme://host[:port], no path/query) before interpolating; warn loudly + omit on misconfig
  // rather than silently corrupting the CSP header.
  const rawBlogHost = process.env.NEXT_PUBLIC_BLOG_HOST;
  let blogHost = '';
  if (rawBlogHost) {
    try {
      if (/[\s;]/.test(rawBlogHost)) throw new Error('contains whitespace or ";"');
      const u = new URL(rawBlogHost);
      if (u.protocol !== 'https:') throw new Error(`must be https (got ${u.protocol})`);
      blogHost = ` ${u.origin}`;
    } catch (e) {
      console.warn(
        `[csp] ignoring invalid NEXT_PUBLIC_BLOG_HOST "${rawBlogHost}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  const cspHeader = `
    default-src 'self';
    script-src ${scriptSrcPolicy};
    style-src ${styleSrcPolicy};
    img-src 'self' blob: data: https://*.amazonaws.com https://www.google.com https://*.gstatic.com https://*.cloudfront.net${filesHost}${blogHost} https://avatars.githubusercontent.com https://*.google-analytics.com https://alb.reddit.com;
    font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com data:;
    connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com https://*.googleapis.com https://*.google.com https://fonts.gstatic.com https://api.bigdatacloud.net https://*.anthropic.com https://*.mail.anthropic.com https://assets.mailerlite.com https://*.stripe.com ws://localhost:* wss://localhost:* http://127.0.0.1:48732 http://localhost:48732 https://*.openai.com https://unpkg.com https://*.cloudfront.net${filesHost}${blogHost} https://cdn.jsdelivr.net https://*.google-analytics.com https://pixel-config.reddit.com https://alb.reddit.com https://api.elevenlabs.io wss://api.elevenlabs.io https://*.livekit.cloud wss://*.livekit.cloud;
    frame-src 'self' blob: https://accounts.google.com https://js.stripe.com https://hooks.stripe.com https://docs.google.com https://drive.google.com https://sheets.google.com https://slides.google.com https://forms.google.com;
    object-src 'none';
    media-src 'self' blob: https://*.amazonaws.com https://*.cloudfront.net https://*.googleapis.com;
    base-uri 'self';
    frame-ancestors 'self';
    form-action 'self';
    worker-src 'self' blob:;
  `
    .replace(/\s{2,}/g, ' ')
    .trim();

  // CSP and HTML-only headers are meaningless on JSON API responses and add ~1KB overhead
  // per call. Browsers do not enforce CSP on non-HTML content types.
  //
  // `/p/*` is excluded too: it rewrites to /api/publish/serve, which sets its OWN
  // strict per-response CSP (bundles: inline <script> stripped + script-src locked
  // to blessed libs; assets + reply/fabfile viewers: script-src 'none'). Applying
  // the global app CSP here would conflict with and weaken that artifact policy.
  // The HTML artifact sandbox follows the same pattern: /api/artifact-sandbox sets
  // its own permissive-but-scoped CSP (style-src https: + connect-src 'none').
  // `/uc/*` (Approach B, #9383) is the per-artifact isolated-origin bundle: it must
  // be EXCLUDED too — it sets its own CSP, and the global `X-Frame-Options: SAMEORIGIN`
  // here would BLOCK the app-origin wrapper from framing the cross-origin usercontent
  // bundle. Its own `frame-ancestors` (scoped to the app host) is the correct control.
  // `/a/*` (no-sign-in share links) rewrites to the same serve handler and likewise
  // sets its own per-response CSP for the sandboxed bundle - the global app CSP would
  // weaken/break it, so exclude it here too.
  if (
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/p/') &&
    !pathname.startsWith('/uc/') &&
    !pathname.startsWith('/a/')
  ) {
    response.headers.set('Content-Security-Policy', cspHeader);
    response.headers.set('X-Frame-Options', 'SAMEORIGIN');
    response.headers.set('X-XSS-Protection', '1; mode=block');
    // HYDRA-007: Restrict browser features. Use `(self)` not `()` for features
    // the app uses (mic for Voice v2 / ElevenLabs Conversational AI, geolocation
    // for profile) — `()` blocks the app itself, not just third-party iframes.
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self), payment=()');
  }

  // Transport-level headers apply to all routes including API.
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // `/a/*` share links set their own `Referrer-Policy: no-referrer` (the token must not
  // leak via Referer on author outbound links) - don't clobber it with the app default.
  if (!pathname.startsWith('/a/')) {
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  if (!request.nextUrl.hostname.includes('localhost')) {
    // preload omitted until subdomain audit confirms all *.bike4mind.com subdomains
    // (preview envs, internal tools) are HTTPS-only — preload list inclusion is permanent.
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  }

  return response;
}

// Apply proxy to all routes
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!_next/static|_next/image|favicon.ico|public/).*)',
  ],
};
