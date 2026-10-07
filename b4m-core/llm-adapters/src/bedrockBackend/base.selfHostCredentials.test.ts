import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Self-host signs Bedrock with the dedicated BEDROCK_AWS_* pair, never the default chain (which
 * would pick up the MinIO AWS_* pair first); hosted keeps the default chain. Both client
 * construction sites are covered, since updateClientForModel rebuilds the client per model.
 */

const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    send = vi.fn();
  },
  InvokeModelCommand: class {},
  InvokeModelWithResponseStreamCommand: class {},
}));

async function buildClients() {
  const { BaseBedrockBackend } = await import('./base');
  class TestBackend extends BaseBedrockBackend {
    formatMessages = (m: never[]) => m;
    getPayload = () => ({ modelId: 'm', contentType: 'application/json', accept: '*/*', body: '{}' });
    translateStreamChunk = () => ({ done: true });
    translateChunk = () => ({ done: true });
    pushToolMessages = () => undefined;
    getModelInfo = async () => [];
    public rebuildFor(model: string) {
      this.updateClientForModel(model);
    }
  }
  clientConfigs.length = 0;
  new TestBackend().rebuildFor('anthropic.claude-3-haiku-20240307-v1:0');
  expect(clientConfigs).toHaveLength(2);
  return clientConfigs;
}

describe('Bedrock client credentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes no explicit credentials on hosted, leaving the default chain', async () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');

    for (const config of await buildClients()) expect(config).not.toHaveProperty('credentials');
  });

  it('signs with BEDROCK_AWS_* on self-host, including the session token', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    vi.stubEnv('BEDROCK_AWS_SESSION_TOKEN', 'session-token');

    for (const config of await buildClients()) {
      expect(config.credentials).toEqual({
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        sessionToken: 'session-token',
      });
    }
  });
});
