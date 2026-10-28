/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />
import { defaultCache } from '@serwist/turbopack/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { Serwist, StaleWhileRevalidate, NetworkOnly } from 'serwist';
import { bypassesServiceWorker, CACHED_CROSS_ORIGIN_HOSTS, isApiPath } from './swRoutes';

// TypeScript declaration for the precache-manifest injection point
// (`self.__SW_MANIFEST`), replaced with the actual manifest at build time.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Silence serwist's dev-mode per-request chatter (`No route found for:`,
  // `Router is responding to:`, etc.) that runs inside the SW and can't be
  // filtered by the main-thread console-override in suppressSerwistWarnings.
  disableDevLogs: true,
  runtimeCaching: [
    // Same-origin Next.js API routes (/api/*) are dynamic and per-request - never serve them from
    // the SW cache. Registered BEFORE defaultCache because defaultCache's broad `.js`/
    // catch-all matchers would otherwise grab HTML API routes (e.g. /api/react-artifact-sandbox),
    // serving a returning user the stale shell for a load after every deploy. First matching route
    // wins, so this must come first.
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && isApiPath(url.pathname),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
    // Additional Google Fonts caching
    {
      matcher: ({ url }) => CACHED_CROSS_ORIGIN_HOSTS.has(url.hostname),
      handler: new StaleWhileRevalidate(),
    },
  ],
  fallbacks: {
    entries: [
      {
        url: '/~offline',
        matcher({ request }) {
          return request.destination === 'document';
        },
      },
    ],
  },
});

// Requests matched by `bypassesServiceWorker` (swRoutes.ts) skip the service worker: cross-origin
// ones because a worker fetch runs under the worker's own, possibly stale, CSP (see swRoutes.ts),
// and Web Worker / Shared Worker entrypoints because of their URL fragment:
//
// Turbopack (Next 16.2.x) loads module workers via a tiny bootstrap entrypoint chunk
// and passes the chunk manifest in the worker URL **fragment** (`#params=...`) for
// dedicated workers. Per the HTML spec, a dedicated worker's `self.location` is set to
// the *response* URL - and a Response served from a cache (or any `respondWith`) has no
// fragment. Serwist's `defaultCache` matches `/_next/static/**.js`, so if the SW answers
// the worker-entrypoint fetch, the `#params=` config is stripped and the worker aborts
// with "Uncaught Error: Missing worker bootstrap config" (breaks the OptiHashi solver race
// and the pyodide runner in prod, where the SW is active; dev has no SW so it works).
//
// Do NOT `respondWith` here - a NetworkOnly route still fetches from the worker under its CSP,
// and its response drops the fragment. Running first and calling `stopImmediatePropagation()`
// keeps Serwist's fetch handler from responding, so the browser performs its native fetch under
// the page's CSP and the worker location keeps its fragment. Registered BEFORE
// `serwist.addEventListeners()` so it runs first.
self.addEventListener('fetch', (event: FetchEvent) => {
  if (bypassesServiceWorker(event.request, self.location.origin)) {
    event.stopImmediatePropagation();
  }
});

serwist.addEventListeners();
