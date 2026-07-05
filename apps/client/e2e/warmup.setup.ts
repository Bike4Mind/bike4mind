import { test as setup } from '@playwright/test';

const WARMUP_TIMEOUT = 90_000;
const RETRY_DELAY = 2_000;
const MAX_RETRIES = 3;

/**
 * Warms a single endpoint with retries. Failures are logged but never
 * block the test suite - cold-start flakiness is reduced, not guaranteed.
 */
async function warmEndpoint(fn: () => Promise<boolean>, label: string) {
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const ok = await fn();
      if (ok) {
        console.log(`  ✓ ${label}`);
        return;
      }
    } catch {
      /* retry */
    }
    if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY));
  }
  console.warn(`  ⚠ ${label} — did not warm (continuing anyway)`);
}

/**
 * Primes Lambda containers, DB connection pools, and Next.js SSR before any
 * setup or test project runs. This eliminates cold-start flakiness where the
 * first request to an endpoint times out or returns stale data.
 */
setup('warm up server endpoints', async ({ request, page }) => {
  setup.setTimeout(WARMUP_TIMEOUT);
  console.log('Warming up server...');

  // Tier 1: API endpoints - primes Lambda bootstrap + DB connection pool
  // NOTE: cleanup endpoint is NOT called here because warmup now runs AFTER
  // setup-core, which creates test data (admin, invite codes). Calling cleanup
  // would destroy that data. global-setup.ts already handles pre-run cleanup.
  await Promise.all([
    warmEndpoint(async () => {
      const res = await request.get('/api/ping');
      return res.ok();
    }, 'GET /api/ping'),
    warmEndpoint(async () => {
      const res = await request.get('/api/models');
      return res.status() !== 500;
    }, 'GET /api/models'),
    warmEndpoint(async () => {
      const res = await request.get('/api/models/stats');
      return res.status() !== 500;
    }, 'GET /api/models/stats'),
    warmEndpoint(async () => {
      const res = await request.get('/api/settings/serverConfigPublic');
      return res.status() !== 500;
    }, 'GET /api/settings/serverConfigPublic'),
  ]);

  // Tier 2: SSR pages - primes Next.js rendering paths (sequential since they share one page)
  // Runs with admin auth (storageState) so pages render fully instead of redirecting to /login.
  for (const route of ['/', '/admin', '/profile']) {
    await warmEndpoint(async () => {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      return true;
    }, `GET ${route} (SSR)`);
  }

  console.log('Warmup complete.');
});
