import { test as setup } from '@playwright/test';
import { TIMEOUTS, MONITORED_MODELS } from './constants';
import { BasePage } from './pages/BasePage';
import { ChatPage } from './pages/ChatPage';
import { ModelSelectorPage } from './pages/ModelSelectorPage';

// The AI-completion warm (Tier 3) can pay a full ChatCompletion Fargate cold start per
// model, so the overall budget must cover that - not the 90s that only Tier 1/2 needed.
// Sized so warmAiModel's own fail-soft handles a dead backend; this ceiling only trips if
// every model warm hangs, and warmup failing would skip every dependent project.
const WARMUP_TIMEOUT = 600_000;
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

  // Tier 3: AI completion path - the ChatCompletion Fargate container + each provider
  // connection. This is the most expensive cold start in the system and the one the
  // credits/timing specs gate on within AI_RESPONSE (120s); a freshly deployed staging
  // serves the first completion cold and blows that budget. Drive one real round-trip per
  // monitored model here so the container/provider are warm before the measured runs - the
  // first model boots the container (slow), later models reuse it (fast). Fail-soft like the
  // rest of warmup: a slow/broken backend must never block the suite (the specs still assert).
  const basePage = new BasePage(page);
  const chatPage = new ChatPage(page);
  const modelSelector = new ModelSelectorPage(page);
  for (const model of MONITORED_MODELS) {
    // Two attempts, each with a full AI_RESPONSE window: if attempt 1 times out because the
    // Fargate task is still booting, that boot completes during it, so attempt 2 lands warm.
    // Two 120s windows cover a ~4-min cold boot - enough headroom without letting a truly
    // dead backend burn the whole WARMUP_TIMEOUT.
    await warmAiModel(async () => {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await basePage.dismissModals();
      await modelSelector.selectTextModel(model);
      const response = await chatPage.sendMessageAndWaitForResponse('Warmup ping - reply OK.', TIMEOUTS.AI_RESPONSE);
      return response.length > 0;
    }, model);
  }

  console.log('Warmup complete.');
});

/**
 * Warm a single AI model with up to two real completion round-trips. Separate from
 * warmEndpoint (3 quick REST retries): AI warms are minutes-long, so the attempt count is
 * kept low and explicit to stay within WARMUP_TIMEOUT. Fail-soft - logs and returns.
 */
async function warmAiModel(fn: () => Promise<boolean>, model: string) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (await fn()) {
        console.log(`  ✓ AI completion (${model})`);
        return;
      }
    } catch {
      /* retry: attempt 1 likely timed out booting the container */
    }
  }
  console.warn(`  ⚠ AI completion (${model}) — did not warm (continuing anyway)`);
}
