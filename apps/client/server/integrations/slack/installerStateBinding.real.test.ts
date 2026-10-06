import { describe, it, expect, beforeAll, vi } from 'vitest';
import { configureSlackPackage, createInstallProvider } from '@bike4mind/slack';
import type { ISlackServerDependencies, ISlackDatabaseDependencies } from '@bike4mind/slack';

vi.mock('@server/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret-for-state-store' } }));

import { createStateToken, verifyStateToken, validateJwtSecret } from '@server/auth/jwtStateStore';

const installOptions = { scopes: ['chat:write'], redirectUri: 'https://example.com/cb' };

beforeAll(() => {
  configureSlackPackage(
    { jwtStateStore: { createStateToken, verifyStateToken, validateJwtSecret } } as unknown as ISlackServerDependencies,
    {
      slackDevWorkspaceRepository: {
        findByIdWithCredentials: async () => ({ slackClientId: 'cid', slackClientSecret: 'secret' }),
      },
    } as unknown as ISlackDatabaseDependencies
  );
});

// Mint with the real signer, verify with the real verifier, through the installer's state store.
describe('install state binding against the real jwt state store', () => {
  const mint = async (nonceHash: string) => {
    const provider = await createInstallProvider('ws-1', { nonceHash });
    return provider.stateStore!.generateStateParam(installOptions, new Date());
  };
  const verify = async (state: string, expectedNonceHash: string | null) => {
    const provider = await createInstallProvider('ws-1', { expectedNonceHash });
    return provider.stateStore!.verifyStateParam(new Date(), state);
  };

  it('verifies with the matching nonce hash', async () => {
    const state = await mint('hash-x');
    await expect(verify(state, 'hash-x')).resolves.toMatchObject({ scopes: installOptions.scopes });
  });

  it('rejects a different nonce hash', async () => {
    await expect(verify(await mint('hash-x'), 'hash-y')).rejects.toThrow();
  });

  it('rejects when the browser presents no nonce (null)', async () => {
    await expect(verify(await mint('hash-x'), null)).rejects.toThrow();
  });

  it('rejects when the verifying provider was created without a binding', async () => {
    const state = await mint('hash-x');
    const provider = await createInstallProvider('ws-1');
    await expect(provider.stateStore!.verifyStateParam(new Date(), state)).rejects.toThrow();
  });
});
