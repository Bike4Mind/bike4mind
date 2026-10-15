import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AuthState } from '@shared/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountSkillsProvider, remoteSkillsKey, type SkillsAuth } from './accountSkills';
import { SkillCatalog } from './SkillCatalog';
import { ProjectTrustStore } from './ProjectTrustStore';

const URL = 'https://app.example.test';
const USER = 'u1';

/**
 * The provider is the only thing that decides where an account's skills are cached and whether
 * they exist at all, and it runs inside `registerChat`, which nothing test-loads. So it is
 * exercised here directly, over a stub AuthService - the same shape the renderer path relies on.
 */
function authStub(state: { api: AuthenticatedApiClient | null; userId: string | undefined }): SkillsAuth {
  return {
    getApiClient: () => state.api,
    getState: () =>
      ({
        status: state.userId ? 'signed-in' : 'signed-out',
        environment: { url: URL },
        user: state.userId ? { id: state.userId } : undefined,
      }) as unknown as AuthState,
  };
}

function client(overrides: Partial<{ get: unknown; getCurrentUser: unknown }> = {}): AuthenticatedApiClient {
  return {
    get: vi.fn(async () => ({ data: [] })),
    getCurrentUser: vi.fn(async () => ({ id: USER })),
    ...overrides,
  } as unknown as AuthenticatedApiClient;
}

describe('accountSkillsProvider', () => {
  let userData: string;

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'b4m-account-skills-'));
  });

  it('offers nothing while there is no authenticated client', () => {
    expect(accountSkillsProvider(authStub({ api: null, userId: USER }), userData)()).toBeNull();
  });

  it('offers nothing while there is no user id, even with a client', () => {
    expect(accountSkillsProvider(authStub({ api: client(), userId: undefined }), userData)()).toBeNull();
  });

  it('keys the account and writes its cache under userData, never the CLI shared file', async () => {
    const get = vi.fn(async () => ({
      data: [{ id: 'a1', name: 'web-summary', description: 'Summarise', body: 'Bike4Mind.', userId: USER }],
    }));
    const provider = accountSkillsProvider(
      authStub({ api: client({ get, getCurrentUser: async () => ({ id: USER }) }), userId: USER }),
      userData
    );

    const remote = provider();
    expect(remote?.key).toBe(remoteSkillsKey(URL, USER));

    await expect(remote!.source.fetchSkills()).resolves.toMatchObject([{ name: 'web-summary' }]);

    const cache = join(userData, 'remote-skills', `${remote!.key}.json`);
    expect(existsSync(cache)).toBe(true);
    const written = JSON.parse(await readFile(cache, 'utf8')) as { skills: { name: string }[] };
    expect(written.skills.map(skill => skill.name)).toEqual(['web-summary']);
    // The request is bounded, so an unresponsive backend cannot stall a catalog read.
    expect(get).toHaveBeenCalledWith('/api/skills?limit=100', { timeout: 5_000 });
  });

  it('reuses the source while the account and the client are the same', () => {
    const state: { api: AuthenticatedApiClient | null; userId: string | undefined } = { api: client(), userId: USER };
    const provider = accountSkillsProvider(authStub(state), userData);

    const first = provider();
    expect(first).not.toBeNull();
    expect(provider()).toBe(first);
  });

  it('rebuilds when the client is replaced, and drops it on sign-out', () => {
    const state: { api: AuthenticatedApiClient | null; userId: string | undefined } = { api: client(), userId: USER };
    const provider = accountSkillsProvider(authStub(state), userData);

    const first = provider();
    state.api = client();
    expect(provider()).not.toBe(first);

    state.api = null;
    expect(provider()).toBeNull();
  });

  it('works as the catalog provider, so account skills reach a state read', async () => {
    const provider = accountSkillsProvider(
      authStub({
        api: client({
          get: async () => ({
            data: [{ id: 'a1', name: 'web-summary', description: 'Summarise', body: 'Body.', userId: USER }],
          }),
          getCurrentUser: async () => ({ id: USER }),
        }),
        userId: USER,
      }),
      userData
    );
    const catalog = new SkillCatalog(new ProjectTrustStore(join(userData, 'trust.json')), provider);

    expect((await catalog.state(null)).skills.map(skill => `${skill.source}:${skill.name}`)).toContain(
      'account:web-summary'
    );
  });
});
