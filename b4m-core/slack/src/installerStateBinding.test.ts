import { describe, it, expect, beforeAll, vi } from 'vitest';
import { configureSlackPackage } from './di/registry';
import { createInstallProvider } from './installer';

const createStateToken = vi.fn((..._args: unknown[]) => 'signed-state');
const verifyStateToken = vi.fn((..._args: unknown[]): unknown => undefined);

const installOptions = { scopes: ['chat:write'], redirectUri: 'https://example.com/cb' };

beforeAll(() => {
  configureSlackPackage(
    { jwtStateStore: { createStateToken, verifyStateToken, validateJwtSecret: () => 'test-secret' } } as never,
    {
      slackDevWorkspaceRepository: {
        findByIdWithCredentials: async () => ({ slackClientId: 'cid', slackClientSecret: 'secret' }),
      },
    } as never
  );
});

describe('createInstallProvider state binding', () => {
  it('embeds nonceHash as the third createStateToken argument', async () => {
    const provider = await createInstallProvider('ws-1', { nonceHash: 'hash-a' });
    await provider.stateStore!.generateStateParam(installOptions, new Date());
    expect(createStateToken.mock.calls[0][2]).toBe('hash-a');
  });

  it.each([['hash-a'], [null]])('passes expectedNonceHash %s as the third verifyStateToken argument', async hash => {
    verifyStateToken.mockReturnValue({ valid: true, payload: { installOptions } });
    const provider = await createInstallProvider('ws-1', { expectedNonceHash: hash });
    await provider.stateStore!.verifyStateParam(new Date(), 'state');
    expect(verifyStateToken.mock.lastCall?.[2]).toBe(hash);
  });

  it.each([
    ['empty binding', [{}]],
    ['no binding', []],
  ] as const)('mints unbound but verifies fail-closed (null, never undefined) when given %s', async (_name, args) => {
    verifyStateToken.mockReturnValue({ valid: true, payload: { installOptions } });
    createStateToken.mockClear();
    const provider = await createInstallProvider('ws-1', ...args);
    await provider.stateStore!.generateStateParam(installOptions, new Date());
    await provider.stateStore!.verifyStateParam(new Date(), 'state');
    expect(createStateToken.mock.calls[0][2]).toBeUndefined();
    expect(verifyStateToken.mock.lastCall?.[2]).toBeNull();
  });

  it('throws when verification rejects the state', async () => {
    verifyStateToken.mockReturnValue({ valid: false, reason: 'invalid', message: 'nope' });
    const provider = await createInstallProvider('ws-1', { expectedNonceHash: 'hash-a' });
    await expect(provider.stateStore!.verifyStateParam(new Date(), 'state')).rejects.toThrow();
  });
});
