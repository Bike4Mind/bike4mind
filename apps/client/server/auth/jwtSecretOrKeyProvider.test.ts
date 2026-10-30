import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { createRequest } from 'node-mocks-http';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';

const { verifyToken, findRotation, decryptAtRest } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  findRotation: vi.fn(),
  decryptAtRest: vi.fn(),
}));

vi.mock('./tokenGenerator', () => ({ authTokenGenerator: { verifyToken } }));
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyNameWithSecret: findRotation },
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'current-secret' } }));
vi.mock('@bike4mind/utils/security', () => ({ decryptAtRest }));

import { jwtSecretOrKeyProvider } from './jwtSecretOrKeyProvider';

const verificationError = new Error('Invalid token');

async function provideSecret() {
  const done = vi.fn();
  const result = jwtSecretOrKeyProvider(createRequest<Request>(), 'test-token', done);
  expect(result).toBeUndefined();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(done).toHaveBeenCalledTimes(1);
  return done;
}

describe('jwtSecretOrKeyProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    verifyToken.mockImplementation(() => {
      throw verificationError;
    });
    findRotation.mockResolvedValue({ rotatedAt: new Date(), previousKey: 'encrypted-secret' });
    decryptAtRest.mockReturnValue('previous-secret');
  });

  it('uses the current secret without querying rotation state for valid tokens', async () => {
    verifyToken.mockReturnValue({});

    const done = await provideSecret();

    expect(done).toHaveBeenCalledWith(null, 'current-secret');
    expect(verifyToken).toHaveBeenCalledExactlyOnceWith('test-token');
    expect(findRotation).not.toHaveBeenCalled();
  });

  it('reports a rejected rotation lookup through done without an unhandled rejection', async () => {
    const databaseError = new Error('EPIPE');
    findRotation.mockRejectedValue(databaseError);

    const done = await provideSecret();

    expect(findRotation).toHaveBeenCalledExactlyOnceWith('JWT_SECRET');
    expect(done).toHaveBeenCalledWith(databaseError);
  });

  it('lets Passport finish authentication when the rotation lookup rejects', async () => {
    const databaseError = new Error('EPIPE');
    findRotation.mockRejectedValue(databaseError);
    const verifyPayload = vi.fn();
    const strategy = new JwtStrategy(
      {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKeyProvider: jwtSecretOrKeyProvider,
      },
      verifyPayload
    );
    strategy.fail = vi.fn();

    strategy.authenticate(createRequest<Request>({ headers: { authorization: 'Bearer test-token' } }), {});
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(strategy.fail).toHaveBeenCalledExactlyOnceWith(databaseError);
    expect(verifyPayload).not.toHaveBeenCalled();
  });

  it('uses the decrypted previous secret during the grace window', async () => {
    verifyToken
      .mockImplementationOnce(() => {
        throw verificationError;
      })
      .mockReturnValue({});

    const done = await provideSecret();

    expect(decryptAtRest).toHaveBeenCalledExactlyOnceWith('encrypted-secret');
    expect(verifyToken).toHaveBeenLastCalledWith('test-token', 'previous-secret');
    expect(done).toHaveBeenCalledWith(null, 'previous-secret');
  });

  it.each([
    ['missing rotation', null],
    ['missing previous key', { rotatedAt: new Date() }],
    ['expired grace window', { rotatedAt: new Date(0), previousKey: 'encrypted-secret' }],
  ])('rejects with the original verification error for %s', async (_description, rotation) => {
    findRotation.mockResolvedValue(rotation);

    const done = await provideSecret();

    expect(done).toHaveBeenCalledWith(verificationError);
    expect(decryptAtRest).not.toHaveBeenCalled();
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it('rejects with the original error when verification with the previous key fails', async () => {
    verifyToken
      .mockImplementationOnce(() => {
        throw verificationError;
      })
      .mockImplementationOnce(() => {
        throw new Error('Previous key mismatch');
      });

    const done = await provideSecret();

    expect(verifyToken).toHaveBeenLastCalledWith('test-token', 'previous-secret');
    expect(done).toHaveBeenCalledWith(verificationError);
  });

  it('rejects with the original error when decryption returns no key', async () => {
    decryptAtRest.mockReturnValue('');

    const done = await provideSecret();

    expect(done).toHaveBeenCalledWith(verificationError);
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it('reports decryption failures through done', async () => {
    const decryptionError = new Error('Cannot decrypt');
    decryptAtRest.mockImplementation(() => {
      throw decryptionError;
    });

    const done = await provideSecret();

    expect(done).toHaveBeenCalledWith(decryptionError);
  });
});
