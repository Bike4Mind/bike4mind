import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockEmbeddingService } from './BedrockEmbeddingService';

/** Self-host signs embeddings with the BEDROCK_AWS_* pair; hosted keeps the default chain. */

const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    send = vi.fn();
  },
  InvokeModelCommand: class {},
}));

function build(): Record<string, unknown> {
  clientConfigs.length = 0;
  new BedrockEmbeddingService();
  expect(clientConfigs).toHaveLength(1);
  return clientConfigs[0];
}

describe('BedrockEmbeddingService credentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes no explicit credentials on hosted, leaving the default chain', () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');

    expect(build()).not.toHaveProperty('credentials');
  });

  it('signs with BEDROCK_AWS_* on self-host, including the session token', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    vi.stubEnv('BEDROCK_AWS_SESSION_TOKEN', 'session-token');

    expect(build().credentials).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'session-token',
    });
  });

  it('rejects on self-host without BEDROCK_AWS_* instead of signing with the MinIO pair', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'minioadminpass');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', '');

    const { credentials } = build();
    expect(credentials).toBeTypeOf('function');
    await expect((credentials as () => Promise<unknown>)()).rejects.toThrow(/BEDROCK_AWS_ACCESS_KEY_ID/);
  });
});
