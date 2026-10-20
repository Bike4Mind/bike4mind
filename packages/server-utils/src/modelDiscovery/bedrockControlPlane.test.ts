import { afterEach, describe, expect, it, vi } from 'vitest';

// The control-plane client must follow the same fail-closed rule as the runtime client: on
// self-host it signs with BEDROCK_AWS_* or rejects, never the default chain (the MinIO AWS_* pair).

const clientConfigs: Record<string, unknown>[] = [];

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: class {
    constructor(config: Record<string, unknown>) {
      clientConfigs.push(config);
    }
    send = vi.fn();
  },
  GetFoundationModelAvailabilityCommand: class {},
  ListFoundationModelsCommand: class {},
}));

const { createBedrockControlPlane } = await import('./bedrockControlPlane');

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function buildConfig(): Record<string, unknown> {
  clientConfigs.length = 0;
  createBedrockControlPlane('us-east-1');
  expect(clientConfigs).toHaveLength(1);
  return clientConfigs[0];
}

describe('createBedrockControlPlane credentials', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('passes no explicit credentials on hosted, leaving the default chain', () => {
    vi.stubEnv('B4M_SELF_HOST', '');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', KEY);
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', SECRET);
    expect(buildConfig()).not.toHaveProperty('credentials');
  });

  it('signs with BEDROCK_AWS_* on self-host', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', KEY);
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('BEDROCK_AWS_SESSION_TOKEN', '');
    expect(buildConfig().credentials).toEqual({ accessKeyId: KEY, secretAccessKey: SECRET });
  });

  it('rejects on self-host without BEDROCK_AWS_* instead of signing with the MinIO pair', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'minioadmin');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'minioadminpass');
    vi.stubEnv('BEDROCK_AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('BEDROCK_AWS_SECRET_ACCESS_KEY', '');
    const { credentials } = buildConfig();
    expect(credentials).toBeTypeOf('function');
    await expect((credentials as () => Promise<unknown>)()).rejects.toThrow(/BEDROCK_AWS_ACCESS_KEY_ID/);
  });
});
