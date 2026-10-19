import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend } from '@bike4mind/common';

// Counters insights can pick a Bedrock model on self-host once BEDROCK_AWS_* lists Bedrock models,
// so its client must sign with that pair, or reject rather than fall back to the MinIO AWS_* pair.

const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    private readonly config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      clientConfigs.push(config);
    }
    // Resolves credentials before "sending", as the SDK's signer does.
    async send() {
      const { credentials } = this.config;
      if (typeof credentials === 'function') await credentials();
      const body = JSON.stringify({ content: [{ text: 'insight' }] });
      return { body: new TextEncoder().encode(body) };
    }
  },
  InvokeModelCommand: class {},
}));

const { generateAgnosticAiInsights } = await import('./agnosticAiInsights');

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const MODEL = 'anthropic.claude-3-haiku-20240307-v1:0';

const run = () => generateAgnosticAiInsights({ logs: [], metrics: {} }, '', ModelBackend.Bedrock, MODEL);

describe('generateAgnosticAiInsights on Bedrock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clientConfigs.length = 0;
  });

  it('passes no explicit credentials on hosted, leaving the default chain', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    expect(await run()).toBe('insight');
    expect(clientConfigs[0]).not.toHaveProperty('credentials');
  });

  it('signs with BEDROCK_AWS_* on self-host', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', KEY);
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('BEDROCK_AWS_SESSION_TOKEN', '');
    expect(await run()).toBe('insight');
    expect(clientConfigs[0].credentials).toEqual({ accessKeyId: KEY, secretAccessKey: SECRET });
  });

  it('rejects on self-host without BEDROCK_AWS_* instead of signing with the MinIO pair', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'minioadminpass');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', '');
    expect(await run()).toBeNull();
    expect(clientConfigs[0].credentials).toBeTypeOf('function');
  });
});
