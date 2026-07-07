// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Real SST throws in the Resource property getter itself when a resource
// isn't linked/provisioned on the current stage - simulate that here instead
// of the plain-object mock in vitest.setup.ts, which never throws.
//
// Covers every field config.ts reads outside the premium-overlay block (those
// are out of scope for this hardening - see config.ts) with a dummy value, so
// a test can vary/omit only the premium fields under test.
const NON_PREMIUM_BASE = {
  MONGODB_URI: { value: 'mongodb://localhost/test' },
  SESSION_SECRET: { value: 'session' },
  JWT_SECRET: { value: 'jwt' },
  App: { stage: 'test' },
  SLACK_WEBHOOK_URL: { value: 'https://hooks.slack.com/test' },
  SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: 'https://hooks.slack.com/test-error' },
  GOOGLE_CLIENT_ID: { value: 'google-id' },
  GOOGLE_CLIENT_SECRET: { value: 'google-secret' },
  GITHUB_CLIENT_ID: { value: 'github-id' },
  GITHUB_CLIENT_SECRET: { value: 'github-secret' },
  STRIPE_WEBHOOK_SECRET: { value: 'stripe-webhook' },
  STRIPE_SECRET_KEY: { value: 'stripe-secret' },
  STRIPE_PUBLISHABLE_KEY: { value: 'stripe-publishable' },
  SUPPORT_EMAIL: { value: 'test@example.com' },
  MAIL_FROM: { value: 'noreply@example.com' },
  MAIL_HOST: { value: 'smtp.example.com' },
  MAIL_PORT: { value: '587' },
  MAIL_USERNAME: { value: 'mail-user' },
  MAIL_PASSWORD: { value: 'mail-pass' },
  ANTHROPIC_API_KEY: { value: 'anthropic-key' },
  GEMINI_API_KEY: { value: 'gemini-key' },
  OKTA_AUDIENCE: { value: 'okta-audience' },
  OKTA_CLIENT_ID: { value: 'okta-id' },
  OKTA_CLIENT_SECRET: { value: 'okta-secret' },
  OKTA_USE_ORG_AUTH_SERVER: { value: 'false' },
  // Left unwrapped in config.ts (manifest.ts marks it hard-required) - see the
  // NOTE comment there. Included here so unrelated tests don't trip on it.
  SECRET_ENCRYPTION_KEY: { value: 'a'.repeat(64) },
};

function mockResourceWithUnlinked(premiumOverrides: Record<string, { value: string } | { stage: string }> = {}) {
  const linked = { ...NON_PREMIUM_BASE, ...premiumOverrides };
  vi.doMock('sst', () => ({
    Resource: new Proxy(linked, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        throw new Error(`${prop} is not linked`);
      },
    }),
  }));
}

describe('Config eager-read hardening', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves unlinked premium-overlay secrets to undefined instead of throwing on import', async () => {
    mockResourceWithUnlinked();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { Config } = await import('./config');

    expect(Config.OPTIHASHI_API_URL).toBeUndefined();
    expect(Config.OPTIHASHI_API_TOKEN).toBeUndefined();
    expect(Config.OPTIHASHI_WEBHOOK_SECRET).toBeUndefined();
    expect(Config.OPTIHASHI_WEBHOOK_SECRET_PREVIOUS).toBeUndefined();
    expect(Config.OVERWATCH_INGEST_ENABLED).toBeUndefined();
    expect(Config.OVERWATCH_INGEST_URL).toBeUndefined();
    expect(Config.OVERWATCH_INGEST_KEY).toBeUndefined();
    expect(Config.OVERWATCH_PSEUDONYM_SALT).toBeUndefined();
    expect(Config.B4M_ANALYTICS_ENABLED).toBeUndefined();
    expect(Config.OAUTH_RSA_PRIVATE_KEY).toBeUndefined();
    expect(Config.SECRET_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();

    // Each unlinked field warns once with its own name, so a mis-provisioned
    // stage is diagnosable in logs rather than silently non-functional.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPTIHASHI_API_URL'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OVERWATCH_INGEST_URL'));
    warnSpy.mockRestore();
  });

  it('does not let one unlinked premium secret take down the hard-required reads', async () => {
    mockResourceWithUnlinked();

    const { Config } = await import('./config');

    expect(Config.MONGODB_URI).toBe('mongodb://localhost/test');
    expect(Config.SESSION_SECRET).toBe('session');
    expect(Config.JWT_SECRET).toBe('jwt');
  });

  it('still fails fast when a hard-required secret is unlinked', async () => {
    vi.doMock('sst', () => ({
      Resource: new Proxy(
        { App: { stage: 'test' } },
        {
          get(target: Record<string, unknown>, prop: string) {
            if (prop in target) return target[prop];
            throw new Error(`${prop} is not linked`);
          },
        }
      ),
    }));

    await expect(import('./config')).rejects.toThrow(/MONGODB_URI is not linked/);
  });

  it('resolves premium-overlay secrets normally when linked', async () => {
    mockResourceWithUnlinked({
      OPTIHASHI_API_URL: { value: 'https://optihashi.example.com' },
      OVERWATCH_INGEST_ENABLED: { value: 'true' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { Config } = await import('./config');

    expect(Config.OPTIHASHI_API_URL).toBe('https://optihashi.example.com');
    expect(Config.OVERWATCH_INGEST_ENABLED).toBe('true');
    // Linked fields never hit the catch, so no warning for them specifically.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OPTIHASHI_API_URL'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OVERWATCH_INGEST_ENABLED'));
    warnSpy.mockRestore();
  });
});
