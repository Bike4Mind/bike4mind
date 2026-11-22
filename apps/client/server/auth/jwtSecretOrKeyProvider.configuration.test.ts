import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createRequest } from 'node-mocks-http';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import jwt from 'jsonwebtoken';

const { configuration, configurationError, findRotation } = vi.hoisted(() => ({
  configuration: { valid: true },
  configurationError: new Error('JWT_SECRET is not configured'),
  findRotation: vi.fn(),
}));

vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyNameWithSecret: findRotation },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    get JWT_SECRET() {
      if (!configuration.valid) throw configurationError;
      return 'current-configured-secret';
    },
  },
}));
vi.mock('@bike4mind/utils/security', () => ({ decryptAtRest: () => 'previous-configured-secret' }));

import { jwtSecretOrKeyProvider } from './jwtSecretOrKeyProvider';

const previousToken = jwt.sign({ id: 'user-1', typ: 'access' }, 'previous-configured-secret', {
  algorithm: 'HS256',
});

describe('JWT configuration refusal through the real token generator and Passport provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configuration.valid = true;
    findRotation.mockResolvedValue({ rotatedAt: new Date(), previousKey: 'encrypted-previous-secret' });
  });

  it('retains previous-key grace when the current key is configured', async () => {
    const done = vi.fn();
    jwtSecretOrKeyProvider(createRequest<Request>(), previousToken, done);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(done).toHaveBeenCalledExactlyOnceWith(null, 'previous-configured-secret');
  });

  it('reports configuration failure without returning the previous key', async () => {
    configuration.valid = false;
    const done = vi.fn();
    jwtSecretOrKeyProvider(createRequest<Request>(), previousToken, done);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(done).toHaveBeenCalledExactlyOnceWith(configurationError);
  });

  it('makes Passport reject a previous-key token while current configuration is invalid', async () => {
    configuration.valid = false;
    const verifyPayload = vi.fn();
    const strategy = new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKeyProvider: jwtSecretOrKeyProvider,
      },
      verifyPayload
    );
    strategy.fail = vi.fn();

    strategy.authenticate(createRequest<Request>({ headers: { authorization: 'Bearer ' + previousToken } }), {});
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(strategy.fail).toHaveBeenCalledExactlyOnceWith(configurationError);
    expect(verifyPayload).not.toHaveBeenCalled();
  });
});
