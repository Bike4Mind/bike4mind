/// <reference types="@testing-library/jest-dom" />
import { vi } from 'vitest';
import { webcrypto } from 'node:crypto';

// DOM matchers only where there is a DOM. This file serves both projects, and loading jest-dom
// cost every node-project file ~80ms for matchers it cannot use. Keyed on `window` rather than on
// the project because a file can switch environment with a `@vitest-environment` docblock. The
// reference above keeps the matcher types global, as the static import used to.
if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}

// Stripe price IDs are account-tied and sourced from NEXT_PUBLIC_* env vars with no
// brand fallback (issue #9306). Seed real-format dummy ids here so the staged
// price-config modules resolve and registry.test.ts's "both stages real" guard
// still validates the wiring. These are NOT real Stripe prices.
process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_TEST ??= 'price_test_org_sub';
process.env.NEXT_PUBLIC_STRIPE_PRICE_ORG_SUB_PROD ??= 'price_prod_org_sub';
process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ??= 'price_test_professional';
process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ??= 'price_prod_professional';
process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_TEST ??= 'price_test_libonc_pro';
process.env.NEXT_PUBLIC_STRIPE_PRICE_LIBONC_PROD ??= 'price_prod_libonc_pro';

// Deployment domain (issue #9306). Publish-security host checks and security-scan target
// URLs derive PUBLISH_HOST / suffix from this; seed it so those modules resolve to the
// bike4mind hosts the existing tests assert (no brand fallback ships in the code itself).
process.env.SERVER_DOMAIN ??= 'bike4mind.com';

// Internal staff domains for the domain-grant path (issue #9306 / #9743). Account-tied
// and sourced from NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS with no brand fallback; seed the
// test/prod value here so registry.test.ts and the verify.ts grant suite exercise the
// internal-domain rows and their signup credits. Not shipped in the code itself.
process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS ??= 'bike4mind.com,milliononmars.com';

// Curated domain->display-name map (#350) so inferOrganizationFromEmail groups the seeded
// internal domain under its curated label. No brand fallback ships in the code itself.
process.env.NEXT_PUBLIC_INTERNAL_ORG_DISPLAY_NAMES ??= 'milliononmars.com:Million on Mars';

// Mock window.matchMedia for MUI Joy UI components (only in browser/jsdom environments)
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock SST Resources to avoid deployment state dependency
vi.mock('sst', () => ({
  Resource: {
    MONGODB_URI: { value: 'mongodb://localhost:27017/test' },
    SESSION_SECRET: { value: 'test-session-secret' },
    JWT_SECRET: { value: 'test-jwt-secret' },
    SLACK_WEBHOOK_URL: { value: 'https://hooks.slack.com/test' },
    SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.com/test-error' },
    GOOGLE_CLIENT_ID: { value: 'test-google-client-id' },
    GOOGLE_CLIENT_SECRET: { value: 'test-google-client-secret' },
    GITHUB_CLIENT_ID: { value: 'test-github-client-id' },
    GITHUB_CLIENT_SECRET: { value: 'test-github-client-secret' },
    GITHUB_LAKE_APP_CLIENT_ID: { value: 'test-github-lake-app-client-id' },
    GITHUB_LAKE_APP_CLIENT_SECRET: { value: 'test-github-lake-app-client-secret' },
    GITHUB_LAKE_APP_ID: { value: '123456' },
    GITHUB_LAKE_APP_PRIVATE_KEY: { value: 'test-github-lake-app-private-key' },
    GITHUB_LAKE_APP_SLUG: { value: 'test-lake-app' },
    GITHUB_LAKE_APP_WEBHOOK_SECRET: { value: 'test-github-lake-app-webhook-secret' },
    githubLakeIngestQueue: { url: 'https://sqs.test/githubLakeIngestQueue' },
    githubLakeRevokeQueue: { url: 'https://sqs.test/githubLakeRevokeQueue' },
    GITHUB_MCP_CLIENT_ID: { value: 'test-github-mcp-client-id' },
    GITHUB_MCP_CLIENT_SECRET: { value: 'test-github-mcp-client-secret' },
    STRIPE_WEBHOOK_SECRET: { value: 'test-stripe-webhook-secret' },
    STRIPE_SECRET_KEY: { value: 'test-stripe-secret' },
    STRIPE_PUBLISHABLE_KEY: { value: 'test-stripe-publishable' },
    SUPPORT_EMAIL: { value: 'test@example.com' },
    MAIL_FROM: { value: 'noreply@example.com' },
    MAIL_HOST: { value: 'smtp.example.com' },
    MAIL_PORT: { value: '587' },
    MAIL_USERNAME: { value: 'test-mail-username' },
    MAIL_PASSWORD: { value: 'test-mail-password' },
    ANTHROPIC_API_KEY: { value: 'test-anthropic-key' },
    GEMINI_API_KEY: { value: 'test-gemini-key' },
    OKTA_AUDIENCE: { value: 'test-okta-audience' },
    OKTA_CLIENT_ID: { value: 'test-okta-client-id' },
    OKTA_CLIENT_SECRET: { value: 'test-okta-client-secret' },
    OKTA_USE_ORG_AUTH_SERVER: { value: 'false' },
    App: { stage: 'test' },
    SLACK_SIGNING_SECRET: { value: 'test-slack-signing-secret' },
    SLACK_APP_ID: { value: 'test-slack-app-id' },
    SLACK_CLIENT_ID: { value: 'test-slack-client-id' },
    SLACK_CLIENT_SECRET: { value: 'test-slack-client-secret' },
    SLACK_OAUTH_REDIRECT_URI: { value: 'http://localhost:3000/api/slack/oauth/callback' },
    OVERWATCH_INGEST_ENABLED: { value: 'true' },
    OVERWATCH_INGEST_URL: { value: 'https://app.bike4mind.com/api/overwatch/v1/events' },
    OVERWATCH_INGEST_KEY: { value: 'b4m_live_testkey1234567890abcdef12345678' },
    OVERWATCH_PRODUCT_INGEST_KEYS: { value: 'not-configured' },
    B4M_ANALYTICS_ENABLED: { value: 'true' },
    OVERWATCH_PSEUDONYM_SALT: { value: 'aaabbbcccddd0000111122223333444455556666777788889999aaaabbbbcccc0001' },
  },
}));

// Polyfill crypto for jsdom
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
});

// Polyfill ResizeObserver for jsdom (not implemented in jsdom)
if (typeof ResizeObserver === 'undefined') {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Polyfill scrollIntoView for jsdom (not implemented in jsdom). Without it, any component
// that scrolls an element into view throws an unhandled TypeError from whatever timer or
// effect called it - which vitest reports as a failed run even when every assertion passed.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// Mock WebsocketContext to avoid import resolution issues in tests
vi.mock('@/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(),
    isConnected: false,
  }),
}));

// The paid-only API key switch (apiKeyAccessGate.ts) reads admin settings and subscriptions, and
// defaults to paid on hosted, so every test that authenticates a key or CLI session would need a
// seeded subscription. Allow by default; suites that exercise the gate mock or unmock it per file.
// The real module is not spread in: it imports the Subscription model, which suites that stub
// @bike4mind/database cannot load.
// The `app` surface of the IP-block gate (checkBlockedIP.ts, mounted on every authenticated write
// by baseApi) reads the active `all` blocks from Mongo. Suites that drive the real baseApi chain
// with connectDB stubbed would wait out Mongoose's 10s command buffer on each write, so that
// surface passes through by default. The `login` surface stays real for the sign-in suites.
// Suites that exercise the app surface mock the module themselves or `vi.unmock` it.
vi.mock('@server/middlewares/checkBlockedIP', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/middlewares/checkBlockedIP')>();
  const passThrough: ReturnType<typeof actual.checkBlockedIP> = (_req, _res, next) => next();
  return {
    ...actual,
    checkBlockedIP: (options: Parameters<typeof actual.checkBlockedIP>[0] = {}) =>
      options.surface === 'app' ? passThrough : actual.checkBlockedIP(options),
    ipBlockRefusal: async (...args: Parameters<typeof actual.ipBlockRefusal>) =>
      args[1] === 'app' ? null : actual.ipBlockRefusal(...args),
  };
});

vi.mock('@server/utils/apiKeyAccessGate', () => ({
  API_KEY_ACCESS_DENIED_MESSAGE: 'API keys require an active paid subscription',
  CLI_ACCESS_DENIED_MESSAGE: 'The CLI and desktop app require an active paid subscription',
  SUBSCRIPTION_REQUIRED_ERROR: 'subscription_required',
  isApiKeyAccessAllowed: async () => true,
  describeApiKeyAccess: async () => ({ mode: 'all', allowed: true, basis: 'open_to_all' }),
  assertApiKeyAccessAllowed: async () => undefined,
  assertCliSessionAllowed: async () => undefined,
}));
