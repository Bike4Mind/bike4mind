import { describe, expect, it, vi } from 'vitest';
import {
  createSstSecretStore,
  createWrappedStageDataKey,
  parseSecretListing,
  type WrappedKeyDeps,
  type WrappedKeyOptions,
} from './createWrappedStageDataKey';

const BLOB = new Uint8Array([1, 2, 3, 250]);

function setup(current: string | undefined, overrides: Partial<WrappedKeyOptions> = {}) {
  const lines: string[] = [];
  const deps = {
    readSecret: vi.fn(async () => current),
    describeKey: vi.fn(async () => ({ enabled: true, arn: 'arn:key' })),
    generateWrappedKey: vi.fn(async () => BLOB),
    setSecret: vi.fn(async () => {}),
    log: (line: string) => lines.push(line),
  } satisfies WrappedKeyDeps;
  const options: WrappedKeyOptions = {
    stage: 'production',
    appName: 'app',
    dryRun: false,
    isPreview: false,
    ...overrides,
  };
  return { deps, lines, run: () => createWrappedStageDataKey(options, deps) };
}

describe('createWrappedStageDataKey', () => {
  it.each(['some-blob', 'x'])('is a no-op when the secret is already set (%s)', async current => {
    const { deps, run, lines } = setup(current);
    expect(await run()).toBe('already-set');
    expect(deps.describeKey).not.toHaveBeenCalled();
    expect(deps.generateWrappedKey).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('already set');
  });

  it.each(['not-configured', 'my-secret-placeholder-value', ' Not-Configured ', ''])(
    'treats %j as unset',
    async current => {
      expect(await setup(current).run()).toBe('created');
    }
  );

  it('--dry-run writes nothing', async () => {
    const { deps, run, lines } = setup('not-configured', { dryRun: true });
    expect(await run()).toBe('dry-run');
    expect(deps.generateWrappedKey).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('alias/app-production-secrets-at-rest');
  });

  it('mints once under the stage context and stores base64 without printing it', async () => {
    const { deps, run, lines } = setup('not-configured');
    expect(await run()).toBe('created');
    expect(deps.generateWrappedKey).toHaveBeenCalledWith('alias/app-production-secrets-at-rest', {
      purpose: 'secrets-at-rest',
      stage: 'production',
    });
    const stored = Buffer.from(BLOB).toString('base64');
    expect(deps.setSecret).toHaveBeenCalledWith('production', stored);
    const hex = Buffer.from(BLOB).toString('hex');
    expect(lines).toEqual([`Set SECRET_DATA_KEY_WRAPPED for stage production (wrapped under arn:key)`]);
    expect(lines.join('\n')).not.toContain(stored);
    expect(lines.join('\n')).not.toContain(hex);
  });

  it('requires --key on a preview and fails on a disabled key', async () => {
    await expect(setup(undefined, { stage: 'pr1', isPreview: true }).run()).rejects.toThrow('--key is required');
    const { deps, run } = setup(undefined);
    deps.describeKey.mockResolvedValue({ enabled: false, arn: 'arn:key' });
    await expect(run()).rejects.toThrow('not enabled');
    expect(deps.setSecret).not.toHaveBeenCalled();
  });
});

describe('parseSecretListing', () => {
  const NAME = 'SECRET_DATA_KEY_WRAPPED';
  const fallback = ['# fallback', 'OTHER=a', `${NAME}=inherited`, 'PEM=-----BEGIN', 'MIIE=', '-----END'];

  it('reads the stage value from its own section, after the fallback section', () => {
    const listing = [...fallback, '', '# app/stage', 'E2E=x', `${NAME}=own`].join('\n');
    expect(parseSecretListing(listing, NAME)).toBe('own');
  });

  it('does not report a fallback-only value as set', () => {
    const listing = [...fallback, '', '# app/stage', 'E2E=x'].join('\n');
    expect(parseSecretListing(listing, NAME)).toBeUndefined();
  });

  it('does not mistake a stage named like the fallback section for it', () => {
    const listing = [...fallback, '', '# bike4mind/fallback-test', `${NAME}=own`].join('\n');
    expect(parseSecretListing(listing, NAME)).toBe('own');
  });

  it('reads a listing that has no section headers', () => {
    expect(parseSecretListing(`A=1\n${NAME}=own`, NAME)).toBe('own');
  });
});

describe('createSstSecretStore', () => {
  it('passes the app name to sst as SEED_APP_NAME on read and write', async () => {
    const exec = vi.fn(() => '# app/dev\nSECRET_DATA_KEY_WRAPPED=blob\n');
    const store = createSstSecretStore('other-app', exec);
    expect(await store.readSecret('dev')).toBe('blob');
    await store.setSecret('dev', 'AQID');
    expect(exec).toHaveBeenCalledTimes(2);
    for (const call of exec.mock.calls as unknown as [string, string[], { env: NodeJS.ProcessEnv }][]) {
      expect(call[2].env.SEED_APP_NAME).toBe('other-app');
    }
    expect(exec.mock.calls[1]).toMatchObject([
      'npx',
      ['sst', 'secret', 'set', 'SECRET_DATA_KEY_WRAPPED', '--stage', 'dev'],
      { input: 'AQID' },
    ]);
  });
});
