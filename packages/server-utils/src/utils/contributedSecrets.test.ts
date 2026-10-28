// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const DECLARED = { secrets: [{ name: 'EXAMPLE_API_TOKEN' }], rotations: [] };

function mockResource(linked: Record<string, { value: string }>) {
  vi.doMock('sst', () => ({
    Resource: new Proxy(linked, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        throw new Error(`${prop} is not linked`);
      },
    }),
  }));
}

async function load(declared = DECLARED) {
  vi.doMock('../premium-generated/infraResources.generated', () => ({
    contributedInfraResources: declared,
    coreResourceNames: ['MONGODB_URI', 'ChatCompletion'],
    coreEnvNames: ['MONGODB_URI', 'CHAT_COMPLETION', 'SERVER_DOMAIN'],
  }));
  return import('./contributedSecrets');
}

describe('contributed secret registry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('sst');
    vi.doUnmock('../premium-generated/infraResources.generated');
    vi.restoreAllMocks();
    delete process.env.EXAMPLE_API_TOKEN;
  });

  it('reads a declared secret without any registration call', async () => {
    mockResource({ EXAMPLE_API_TOKEN: { value: 'token-1' } });
    const { readContributedSecret } = await load();
    expect(readContributedSecret('EXAMPLE_API_TOKEN')).toBe('token-1');
  });

  it('resolves nothing when no overlay declares secrets', async () => {
    mockResource({ EXAMPLE_API_TOKEN: { value: 'token-1' } });
    const { readContributedSecret } = await load({ secrets: [], rotations: [] });
    expect(readContributedSecret('EXAMPLE_API_TOKEN')).toBeUndefined();
  });

  it('never reads an unregistered name, even when it is linked', async () => {
    mockResource({ MONGODB_URI: { value: 'mongodb://x' } });
    const { readContributedSecret } = await load();
    expect(readContributedSecret('MONGODB_URI')).toBeUndefined();
  });

  it('drops a contribution that collides with a core secret', async () => {
    mockResource({ MONGODB_URI: { value: 'mongodb://x' } });
    const { registerContributedSecrets, readContributedSecret } = await load({ secrets: [], rotations: [] });
    const result = registerContributedSecrets([{ name: 'MONGODB_URI' }]);
    expect(result.coreCollisions).toEqual(['MONGODB_URI']);
    expect(readContributedSecret('MONGODB_URI')).toBeUndefined();
  });

  it('rejects a camelCase name whose env var form would alias another variable', async () => {
    mockResource({});
    process.env.MONGODB_URI_TEST_ALIAS = 'core-credential';
    const { registerContributedSecrets, readContributedSecret } = await load({
      secrets: [{ name: 'MongodbUriTestAlias' }],
      rotations: [],
    });
    expect(registerContributedSecrets([{ name: 'MongodbUri' }]).rejected).toEqual(['MongodbUri']);
    expect(readContributedSecret('MongodbUriTestAlias')).toBeUndefined();
    delete process.env.MONGODB_URI_TEST_ALIAS;
  });

  it.each(['CHAT_COMPLETION', 'SERVER_DOMAIN'])(
    'never registers %s, a core env var, nor reads its value',
    async name => {
      mockResource({});
      process.env[name] = 'core-value';
      try {
        const { registerContributedSecrets, readContributedSecret } = await load({
          secrets: [{ name }],
          rotations: [],
        });
        expect(registerContributedSecrets([{ name }]).coreCollisions).toEqual([name]);
        expect(readContributedSecret(name)).toBeUndefined();
      } finally {
        delete process.env[name];
      }
    }
  );

  it('keeps the first registration of a duplicate and drops empty names', async () => {
    mockResource({});
    const { registerContributedSecrets, isContributedSecret } = await load();
    expect(isContributedSecret('EXAMPLE_API_TOKEN')).toBe(true);
    const result = registerContributedSecrets([{ name: 'EXAMPLE_API_TOKEN' }, { name: '' }]);
    expect(result.duplicates).toEqual(['EXAMPLE_API_TOKEN']);
    expect(result.rejected).toEqual(['']);
  });

  it('degrades to undefined when a registered secret is not linked', async () => {
    mockResource({});
    const { readContributedSecret } = await load();
    expect(readContributedSecret('EXAMPLE_API_TOKEN')).toBeUndefined();
  });

  it('falls back to the env var when the Resource shim does not know the name', async () => {
    mockResource({});
    process.env.EXAMPLE_API_TOKEN = 'from-env';
    const { readContributedSecret } = await load();
    expect(readContributedSecret('EXAMPLE_API_TOKEN')).toBe('from-env');
  });
});
