import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import { ConflictError, createOAuthClientSchema, resolveOAuthFederatedIdp } from '@bike4mind/common';

const { db } = vi.hoisted(() => ({
  db: {
    createOAuthClient: vi.fn(),
    mongoose: { connect: vi.fn(), disconnect: vi.fn() },
    OAuthClientModel: { findOne: vi.fn() },
  },
}));
vi.mock('@bike4mind/database', () => db);

import { formatZodError, main, readFederatedIdpEnv, resolveClientType, runSeed } from './seed-oauth-client';

const priorClientType = process.env.CLIENT_TYPE;

afterEach(() => {
  if (priorClientType === undefined) delete process.env.CLIENT_TYPE;
  else process.env.CLIENT_TYPE = priorClientType;
});

describe('resolveClientType', () => {
  it('defaults an unclassified registration to the non-privileged relying-party class', () => {
    delete process.env.CLIENT_TYPE;
    expect(resolveClientType()).toBe('relying-party');
  });

  it('allows an explicit first-party opt-in', () => {
    process.env.CLIENT_TYPE = 'first-party';
    expect(resolveClientType()).toBe('first-party');
  });

  it('rejects an unknown value rather than silently trusting it', () => {
    process.env.CLIENT_TYPE = 'privileged';
    expect(() => resolveClientType()).toThrow(/CLIENT_TYPE/);
  });
});

describe('readFederatedIdpEnv', () => {
  const KEYS = [
    'FEDERATED_ISSUER',
    'FEDERATED_AUDIENCE',
    'FEDERATED_PROVIDER_NAME',
    'FEDERATED_JWKS_URI',
    'FEDERATED_SUBJECT_SOURCE',
  ];
  const prior = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

  afterEach(() => {
    for (const k of KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });

  it('returns undefined for a non-federated registration', () => {
    for (const k of KEYS) delete process.env[k];
    expect(readFederatedIdpEnv()).toBeUndefined();
  });

  it('passes the raw values through for the shared resolver to validate', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.FEDERATED_SUBJECT_SOURCE = 'sub';
    process.env.FEDERATED_ISSUER = 'https://b4m.example.test';
    expect(readFederatedIdpEnv()).toEqual({ subjectSource: 'sub', issuer: 'https://b4m.example.test' });
  });

  it('lets FEDERATED_SUBJECT_SOURCE=identities alone reach the resolver, which rejects it', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.FEDERATED_SUBJECT_SOURCE = 'identities';
    const input = readFederatedIdpEnv();
    expect(input).toEqual({ subjectSource: 'identities' });
    expect(() => resolveOAuthFederatedIdp(input, 'cid')).toThrow(/together/);
  });

  it('rejects an unknown subject source', () => {
    process.env.FEDERATED_SUBJECT_SOURCE = 'email';
    expect(() => readFederatedIdpEnv()).toThrow(/FEDERATED_SUBJECT_SOURCE/);
  });
});

describe('runSeed', () => {
  const env = {
    MONGODB_URI: 'mongodb://localhost:27017/test',
    CLIENT_NAME: ' My App ',
    REDIRECT_URIS: ' https://a.example.test/cb , ,http://localhost:3000/cb,',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    db.mongoose.connect.mockResolvedValue(undefined);
    db.mongoose.disconnect.mockResolvedValue(undefined);
  });

  it('drops blank entries from REDIRECT_URIS and returns the created client', async () => {
    db.createOAuthClient.mockResolvedValue({ client: { clientId: 'cid' }, clientSecret: 's3cret' });
    const result = await runSeed(env);

    expect(db.createOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUris: ['https://a.example.test/cb', 'http://localhost:3000/cb'],
        clientType: 'relying-party',
      })
    );
    expect(result).toMatchObject({ status: 'created', clientSecret: 's3cret' });
    expect(db.mongoose.disconnect).toHaveBeenCalled();
  });

  it('resolves to the existing client_id (the exit-0 path) on a duplicate name, looked up by trimmed name', async () => {
    db.createOAuthClient.mockRejectedValue(new ConflictError('exists'));
    db.OAuthClientModel.findOne.mockReturnValue({ exec: () => Promise.resolve({ clientId: 'b4m_my_app_0011aabb' }) });

    await expect(runSeed(env)).resolves.toEqual({
      status: 'exists',
      name: 'My App',
      clientId: 'b4m_my_app_0011aabb',
    });
    expect(db.OAuthClientModel.findOne).toHaveBeenCalledWith({ name: 'My App' });
    expect(db.mongoose.disconnect).toHaveBeenCalled();
  });

  it('rethrows any other error (the exit-1 path) and still disconnects', async () => {
    db.createOAuthClient.mockRejectedValue(new Error('db down'));
    await expect(runSeed(env)).rejects.toThrow('db down');
    expect(db.OAuthClientModel.findOne).not.toHaveBeenCalled();
    expect(db.mongoose.disconnect).toHaveBeenCalled();
  });

  it('requires MONGODB_URI before connecting', async () => {
    await expect(runSeed({ ...env, MONGODB_URI: undefined })).rejects.toThrow(/MONGODB_URI/);
    expect(db.mongoose.connect).not.toHaveBeenCalled();
  });
});

describe('formatZodError', () => {
  it('lists each issue with its path instead of a raw stack', () => {
    const parsed = createOAuthClientSchema.safeParse({ name: 'A', redirectUris: ['http://app.example.test/cb'] });
    if (parsed.success) throw new Error('expected a validation failure');
    expect(formatZodError(parsed.error)).toMatch(/redirectUris\.0: .*https/);
  });
});

describe('main', () => {
  const MAIN_ENV = {
    MONGODB_URI: 'mongodb://localhost:27017/test',
    CLIENT_NAME: ' My App ',
    REDIRECT_URIS: 'https://a.example.test/cb',
  };
  const priorEnv = { ...process.env };
  let exit: MockInstance;
  let log: MockInstance;
  let error: MockInstance;

  const printed = (spy: MockInstance) => spy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, MAIN_ENV);
    db.mongoose.connect.mockResolvedValue(undefined);
    db.mongoose.disconnect.mockResolvedValue(undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of Object.keys(MAIN_ENV)) {
      if (priorEnv[k] === undefined) delete process.env[k];
      else process.env[k] = priorEnv[k];
    }
  });

  it('prints the existing client_id and the trimmed name, then exits 0, on a duplicate name', async () => {
    db.createOAuthClient.mockRejectedValue(new ConflictError('exists'));
    db.OAuthClientModel.findOne.mockReturnValue({ exec: () => Promise.resolve({ clientId: 'b4m_my_app_0011aabb' }) });

    await main();

    expect(printed(log)).toContain('Client "My App" already exists');
    expect(printed(log)).toContain('b4m_my_app_0011aabb');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('prints a readable Invalid input list and exits 1 on a ZodError', async () => {
    process.env.REDIRECT_URIS = 'http://app.example.test/cb';
    const parsed = createOAuthClientSchema.safeParse({ name: 'A', redirectUris: ['http://app.example.test/cb'] });
    if (parsed.success) throw new Error('expected a validation failure');
    db.createOAuthClient.mockRejectedValue(parsed.error);

    await main();

    expect(printed(error)).toMatch(/Invalid input:\n {2}- redirectUris\.0: .*https/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 on any other error', async () => {
    db.createOAuthClient.mockRejectedValue(new Error('db down'));
    await main();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  it('prints the client_secret exactly once on success', async () => {
    db.createOAuthClient.mockResolvedValue({
      client: { clientId: 'cid', clientType: 'relying-party', name: 'My App' },
      clientSecret: 'one-time-s3cret',
    });

    await main();

    const out = printed(log);
    expect(out.split('one-time-s3cret')).toHaveLength(2);
    expect(exit).not.toHaveBeenCalled();
  });
});
