import { vi } from 'vitest';
import '@testing-library/jest-dom';
import { webcrypto } from 'node:crypto';

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

// Mock WebsocketContext to avoid import resolution issues in tests
vi.mock('@/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    send: vi.fn(),
    isConnected: false,
  }),
}));
