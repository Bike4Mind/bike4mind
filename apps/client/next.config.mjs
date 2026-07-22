// @ts-check

// Service Worker (Serwist):
// - Using @serwist/turbopack with route handler at app/serwist/[path]/route.ts
// - SerwistProvider wraps the app in layout.tsx

// Pin monorepo root for both Turbopack and output file tracing (must match)
const monorepoRoot = new URL('../../', import.meta.url).pathname;

// Self-host build only (open-core #9313): alias `sst` → the env-backed
// `@bike4mind/resource` shim, so the app resolves config from plain env vars
// instead of the SST/AWS runtime. `Resource` is the only symbol the code
// imports from `sst`, so aliasing the whole module is safe. Gated on
// B4M_SELF_HOST so the normal SST build (staging/prod) is completely unaffected.
const selfHostResolveAlias = process.env.B4M_SELF_HOST === 'true' ? { sst: '@bike4mind/resource' } : {};

// NEXT_PUBLIC_CDN_URL is an absolute URL on deployed stages, but on personal
// `sst dev` stages it is the relative local file-proxy base ('/api/app-files/serve'),
// which is same-origin and needs no remote-image pattern. Only derive a hostname
// when it parses as an absolute URL; otherwise fall back to the default CDN host.
const cdnImageHostname = (() => {
  const cdn = process.env.NEXT_PUBLIC_CDN_URL;
  if (cdn && /^https?:\/\//i.test(cdn)) {
    try {
      return new URL(cdn).hostname;
    } catch {
      // not a parseable absolute URL — fall through to default
    }
  }
  return 'files.dev.bike4mind.com';
})();

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Self-host build only (open-core #9313): emit a standalone server bundle for
  // the Docker image. The normal SST/OpenNext build manages its own output, so
  // this is gated on B4M_SELF_HOST to leave staging/prod untouched.
  // Also inline B4M_SELF_HOST into the client bundle so shared code (e.g. the
  // settingsMap defaults in @bike4mind/common) can resolve self-host-aware
  // defaults in the browser, not just on the server.
  ...(process.env.B4M_SELF_HOST === 'true' ? { output: 'standalone', env: { B4M_SELF_HOST: 'true' } } : {}),

  // Disable production source maps to reduce bundle size by 20-30%
  // Can be enabled temporarily for debugging with ENABLE_SOURCE_MAPS=true
  productionBrowserSourceMaps: process.env.ENABLE_SOURCE_MAPS === 'true',

  // The Deploy job's `Run Tests` step already runs `pnpm turbo:typecheck` —
  // letting Next re-run tsc inside `next build` is the OOM trigger documented
  // at https://nextjs.org/docs/app/guides/memory-usage#disable-static-analysis
  typescript: {
    ignoreBuildErrors: true,
  },

  // Must match turbopack.root — SST/OpenNext may also inject this value
  outputFileTracingRoot: monorepoRoot,

  transpilePackages: [
    'react-syntax-highlighter',
    '@icons-pack/react-simple-icons',
    'pdfjs-dist',
    // ESM-only packages that need transpilation for API routes
    'p-limit',
    'yocto-queue',
    // Nivo packages
    '@nivo/pie',
    '@nivo/line',
    '@nivo/bar',

    // All D3 packages
    'd3-shape',
    'd3-scale',
    'd3-scale-chromatic',
    'd3-delaunay',
    'd3-interpolate',
    'd3-color',
    'd3-format',
    'd3-time',
    'd3-time-format',
    'd3-array',
    'd3-collection',
    'd3-dispatch',
    'd3-drag',
    'd3-ease',
    'd3-force',
    'd3-hierarchy',
    'd3-path',
    'd3-polygon',
    'd3-quadtree',
    'd3-random',
    'd3-selection',
    'd3-timer',
    'd3-transition',
    'd3-zoom',

    // Premium overlay packages — source packages transpiled by the Next.js bundler
    '@bike4mind/premium-libreoncology',
    '@bike4mind/premium-overwatch',
    // optihashi added for the B1 worker-bundling spike: its client route +
    // web worker (new Worker(new URL(...))) must be run through the Next.js
    // loaders so the bundler (Turbopack in Next 16) emits the worker chunk.
    // Retained through M1a.
    '@bike4mind/premium-optihashi',
  ],

  serverExternalPackages: [
    '@aws-sdk/client-bedrock-runtime',
    '@aws-sdk/client-s3',
    '@aws-sdk/client-transcribe',
    '@aws-sdk/credential-provider-node',
    '@opensearch-project/opensearch',
    // Serwist uses esbuild to bundle the service worker at runtime
    'esbuild',
    'esbuild-wasm',
  ],

  pageExtensions: ['ts', 'tsx', 'js', 'jsx'],
  images: {
    remotePatterns: [
      {
        // Generated Images bucket:
        protocol: 'https',
        // Example: pr535-groktool-buckets-generatedimagesbucket064ab0-zw27yiznd2ig.s3.us-east-2.amazonaws.com
        // Example: dev-groktool-buckets-generatedimagesbucket.s3.us-east.amazonaws.com
        hostname:
          process.env.GENERATED_IMAGES_BUCKET_NAME ||
          '*-groktool-buckets-generatedimagesbucket*.s3.us-east-2.amazonaws.com',
      },
      {
        // fab files bucket:
        protocol: 'https',
        // Example: pr535-groktool-buckets-fabfilesbucket.s3.us-east-2.amazonaws.com
        // Example: dev-groktool-buckets-fabfilesbucket.s3.us-east.amazonaws.com
        hostname: process.env.FAB_FILES_BUCKET_NAME || '*-groktool-buckets-fabfilesbucket*.s3.us-east-2.amazonaws.com',
      },
      {
        // app files bucket (for logos, etc.):
        protocol: 'https',
        // Example: bike4mind-millions-appfilesbucketbucket-kfmksobd.s3.us-east-2.amazonaws.com
        hostname: process.env.APP_FILES_BUCKET_NAME || '*-appfilesbucket*.s3.us-east-2.amazonaws.com',
      },
      {
        // cdn url
        protocol: 'https',
        hostname: cdnImageHostname,
      },
      {
        // GitHub user avatars (used by B4M Pi team activity)
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        // GitHub profile avatars (used by B4M Pi insights team profiles)
        // Historical analysis stores URLs as github.com/username.png
        protocol: 'https',
        hostname: 'github.com',
      },
    ],
  },
  // Turbopack is the default in Next.js 16
  turbopack: {
    // Pin workspace root to lumina5/ so Turbopack doesn't walk up to ~/Desktop/
    root: monorepoRoot,
    // Stub Node.js modules for browser builds (e.g., HiGHS WASM loader uses require('fs'))
    resolveAlias: {
      ...selfHostResolveAlias,
      canvas: { browser: './empty-module.js' },
      fs: { browser: './empty-module.js' },
      path: { browser: './empty-module.js' },
      net: { browser: './empty-module.js' },
      tls: { browser: './empty-module.js' },
      child_process: { browser: './empty-module.js' },
    },
  },

  async rewrites() {
    return [
      // OIDC discovery endpoints — required for Cognito OIDC IdP and other relying parties
      {
        source: '/.well-known/openid-configuration',
        destination: '/api/oauth/openid-configuration',
      },
      {
        source: '/.well-known/jwks.json',
        destination: '/api/oauth/jwks',
      },
      // Published-artifact public viewer. Pretty `/p/*` URLs are served by the
      // gated serve handler (auth-bypass + per-request visibility check + CSP).
      // Routing to /api keeps it out of the SPA and out of proxy.ts's global CSP
      // so the handler sets its own per-response CSP.
      {
        source: '/p/:path*',
        destination: '/api/publish/serve/:path*',
      },
      // Approach B (#9383): per-artifact isolated-origin bundle content. Served by the
      // SAME handler but only on `{publicId}.usercontent.app.<domain>`; the distinct `/uc`
      // path (vs `/p`) keeps the app-origin wrapper and the isolated bundle from colliding
      // in a CDN cache that doesn't key on Host. `__uc=1` flags the handler into isolated mode.
      {
        source: '/uc/:path*',
        destination: '/api/publish/serve/:path*?__uc=1',
      },
      // No-sign-in share links: `/a/<shareToken>[/asset]` resolve to the same serve
      // handler by capability token. `:path*` so bundle asset sub-paths route through
      // too. Served same-origin, sandboxed, always noindex/no-store (see the handler).
      {
        source: '/a/:path*',
        destination: '/api/publish/serve/a/:path*',
      },
      // Public embeddable chat widget. Pretty `/embed/*` URLs (the iframe src on
      // customer sites) are served by the unauth embed serve handler, which sets
      // its own per-response CSP with frame-ancestors derived from the embed
      // key's allowedOrigins. Routing to /api keeps it out of the SPA and out of
      // proxy.ts's global CSP so the handler's own headers win.
      {
        source: '/embed/:path*',
        destination: '/api/embed/serve',
      },
    ];
  },
  poweredByHeader: false,
  // This is to hide the Next.js dev indicator floating element, which tends to overlay on top of the buttons in our app
  devIndicators: false,
  experimental: {
    // This is to optimize the package imports for the app
    optimizePackageImports: [
      '@bike4mind/common',
      '@bike4mind/mcp',
      '@bike4mind/services',
      '@bike4mind/utils',
      '@icons-pack/react-simple-icons',
    ],
    // Skip server source map generation to reduce build memory pressure on CI.
    // Recommended in the Next.js memory-usage guide for large projects.
    serverSourceMaps: false,
  },
};

export default nextConfig;
