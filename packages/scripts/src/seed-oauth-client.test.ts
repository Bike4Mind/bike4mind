import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import {
  ConflictError,
  createOAuthClientSchema,
  FEDERATED_ADMIN_STATUS_SCOPE,
  NotFoundError,
  resolveOAuthFederatedIdp,
} from '@bike4mind/common';

const { db } = vi.hoisted(() => ({
  db: {
    createOAuthClient: vi.fn(),
    addOAuthClientOptInScopes: vi.fn(),
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

  describe('OPT_IN_SCOPES', () => {
    const federatedEnv = {
      ...env,
      FEDERATED_SUBJECT_SOURCE: 'sub',
      FEDERATED_ISSUER: 'https://b4m.example.test',
      FEDERATED_JWKS_URI: 'https://b4m.example.test/api/oauth/jwks',
      OPT_IN_SCOPES: ` ${FEDERATED_ADMIN_STATUS_SCOPE} ,`,
    };

    it('grants the scope to a newly created client and returns the updated scopes', async () => {
      db.createOAuthClient.mockResolvedValue({
        client: { clientId: 'cid', allowedScopes: ['openid'] },
        clientSecret: 's',
      });
      db.addOAuthClientOptInScopes.mockResolvedValue({
        clientId: 'cid',
        allowedScopes: ['openid', FEDERATED_ADMIN_STATUS_SCOPE],
      });

      const result = await runSeed(federatedEnv);

      expect(db.addOAuthClientOptInScopes).toHaveBeenCalledWith('cid', [FEDERATED_ADMIN_STATUS_SCOPE]);
      expect(result).toMatchObject({
        status: 'created',
        clientSecret: 's',
        client: { allowedScopes: ['openid', FEDERATED_ADMIN_STATUS_SCOPE] },
      });
    });

    it('returns the created client and its still-valid secret when the grant fails, instead of losing it', async () => {
      db.createOAuthClient.mockResolvedValue({
        client: { clientId: 'cid', allowedScopes: ['openid'] },
        clientSecret: 's',
      });
      db.addOAuthClientOptInScopes.mockRejectedValue(new Error('mongo gone'));

      const result = await runSeed(federatedEnv);

      expect(result).toMatchObject({ status: 'created', clientSecret: 's', client: { clientId: 'cid' } });
      expect(result.status === 'created' && result.grantError?.message).toBe('mongo gone');
      expect(db.OAuthClientModel.findOne).not.toHaveBeenCalled();
      expect(db.mongoose.disconnect).toHaveBeenCalled();
    });

    it('refuses to grant by name on a duplicate-name rerun, so an arbitrary duplicate is never targeted', async () => {
      db.createOAuthClient.mockRejectedValue(new ConflictError('exists'));
      await expect(runSeed(federatedEnv)).rejects.toThrow(/TARGET_CLIENT_ID/);
      expect(db.addOAuthClientOptInScopes).not.toHaveBeenCalled();
      expect(db.OAuthClientModel.findOne).not.toHaveBeenCalled();
      expect(db.mongoose.disconnect).toHaveBeenCalled();
    });

    it('grants to TARGET_CLIENT_ID without reading CLIENT_NAME, REDIRECT_URIS or FEDERATED_*', async () => {
      const client = { clientId: 'b4m_my_app_0011aabb', allowedScopes: ['openid', FEDERATED_ADMIN_STATUS_SCOPE] };
      db.addOAuthClientOptInScopes.mockResolvedValue(client);

      const result = await runSeed({
        MONGODB_URI: env.MONGODB_URI,
        TARGET_CLIENT_ID: ' b4m_my_app_0011aabb ',
        OPT_IN_SCOPES: FEDERATED_ADMIN_STATUS_SCOPE,
      });

      expect(db.addOAuthClientOptInScopes).toHaveBeenCalledWith('b4m_my_app_0011aabb', [FEDERATED_ADMIN_STATUS_SCOPE]);
      expect(db.createOAuthClient).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'scopes-granted', client });
      expect(db.mongoose.disconnect).toHaveBeenCalled();
    });

    it('rejects TARGET_CLIENT_ID without OPT_IN_SCOPES before connecting', async () => {
      await expect(runSeed({ MONGODB_URI: env.MONGODB_URI, TARGET_CLIENT_ID: 'b4m_x' })).rejects.toThrow(
        /OPT_IN_SCOPES/
      );
      expect(db.mongoose.connect).not.toHaveBeenCalled();
    });

    it('propagates a rejected grant in TARGET_CLIENT_ID mode and still disconnects', async () => {
      db.addOAuthClientOptInScopes.mockRejectedValue(new NotFoundError('OAuth client not found'));

      await expect(
        runSeed({
          MONGODB_URI: env.MONGODB_URI,
          TARGET_CLIENT_ID: 'b4m_missing_0a1b2c3d',
          OPT_IN_SCOPES: FEDERATED_ADMIN_STATUS_SCOPE,
        })
      ).rejects.toThrow(NotFoundError);
      expect(db.createOAuthClient).not.toHaveBeenCalled();
      expect(db.mongoose.disconnect).toHaveBeenCalled();
    });

    it('does not call the helper when unset', async () => {
      db.createOAuthClient.mockResolvedValue({ client: { clientId: 'cid' }, clientSecret: 's' });
      await runSeed(env);
      db.createOAuthClient.mockRejectedValue(new ConflictError('exists'));
      db.OAuthClientModel.findOne.mockReturnValue({ exec: () => Promise.resolve({ clientId: 'cid' }) });
      await runSeed(env);
      expect(db.addOAuthClientOptInScopes).not.toHaveBeenCalled();
    });

    it('rejects an unknown scope before connecting', async () => {
      await expect(runSeed({ ...federatedEnv, OPT_IN_SCOPES: 'admin:all' })).rejects.toThrow(/OPT_IN_SCOPES/);
      expect(db.mongoose.connect).not.toHaveBeenCalled();
    });

    it.each<[string, Record<string, string>]>([
      ['a non-federated client', { ...env, OPT_IN_SCOPES: FEDERATED_ADMIN_STATUS_SCOPE }],
      ['a first-party client', { ...federatedEnv, CLIENT_TYPE: 'first-party' }],
    ])('refuses to create %s it could not grant the scope to, before connecting', async (_name, seedEnv) => {
      await expect(runSeed(seedEnv)).rejects.toThrow(/FEDERATED_\* and a relying-party/);
      expect(db.mongoose.connect).not.toHaveBeenCalled();
      expect(db.createOAuthClient).not.toHaveBeenCalled();
    });
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

  it('prints the granted scopes and exits 0 in TARGET_CLIENT_ID mode', async () => {
    process.env.TARGET_CLIENT_ID = 'b4m_my_app_0011aabb';
    process.env.OPT_IN_SCOPES = FEDERATED_ADMIN_STATUS_SCOPE;
    db.addOAuthClientOptInScopes.mockResolvedValue({
      name: 'My App',
      clientId: 'b4m_my_app_0011aabb',
      allowedScopes: ['openid', FEDERATED_ADMIN_STATUS_SCOPE],
    });
    try {
      await main();
    } finally {
      delete process.env.TARGET_CLIENT_ID;
      delete process.env.OPT_IN_SCOPES;
    }

    expect(printed(log)).toContain(`openid ${FEDERATED_ADMIN_STATUS_SCOPE}`);
    expect(db.createOAuthClient).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still prints the one-time secret and exits 1 when the grant fails after creating the client', async () => {
    process.env.FEDERATED_ISSUER = 'https://b4m.example.test';
    process.env.OPT_IN_SCOPES = FEDERATED_ADMIN_STATUS_SCOPE;
    db.createOAuthClient.mockResolvedValue({
      client: { clientId: 'cid', clientType: 'relying-party', name: 'My App', allowedScopes: ['openid'] },
      clientSecret: 'one-time-s3cret',
    });
    db.addOAuthClientOptInScopes.mockRejectedValue(new Error('mongo gone'));
    try {
      await main();
    } finally {
      delete process.env.FEDERATED_ISSUER;
      delete process.env.OPT_IN_SCOPES;
    }

    expect(printed(log)).toContain('one-time-s3cret');
    expect(printed(error)).toContain('mongo gone');
    expect(printed(error)).toContain('TARGET_CLIENT_ID="cid"');
    expect(exit).toHaveBeenCalledWith(1);
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
      client: { clientId: 'cid', clientType: 'relying-party', name: 'My App', allowedScopes: ['openid'] },
      clientSecret: 'one-time-s3cret',
    });

    await main();

    const out = printed(log);
    expect(out.split('one-time-s3cret')).toHaveLength(2);
    expect(exit).not.toHaveBeenCalled();
  });
});
