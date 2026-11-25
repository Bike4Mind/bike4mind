import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createWrappedStageDataKey,
  parseSecretListing,
  SECRETS_AT_REST_PURPOSE,
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
    force: false,
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
    expect(lines).toEqual([`Set SECRET_ENCRYPTION_KEY_WRAPPED for stage production (wrapped under arn:key)`]);
    expect(lines.join('\n')).not.toContain(stored);
    expect(lines.join('\n')).not.toContain(hex);
  });

  it('--force replaces an existing blob', async () => {
    const { deps, run } = setup('old', { force: true });
    expect(await run()).toBe('created');
    expect(deps.setSecret).toHaveBeenCalledTimes(1);
    expect(deps.setSecret).toHaveBeenCalledWith('production', Buffer.from(BLOB).toString('base64'));
  });

  it('requires --key on a preview and fails on a disabled key', async () => {
    await expect(setup(undefined, { stage: 'pr1', isPreview: true }).run()).rejects.toThrow('--key is required');
    const { deps, run } = setup(undefined);
    deps.describeKey.mockResolvedValue({ enabled: false, arn: 'arn:key' });
    await expect(run()).rejects.toThrow('not enabled');
    expect(deps.setSecret).not.toHaveBeenCalled();
  });

  it('uses the same purpose as infra/secretsAtRestKey.ts', () => {
    const infra = readFileSync(resolve(__dirname, '../../../infra/secretsAtRestKey.ts'), 'utf8');
    expect(infra).toContain(`SECRETS_AT_REST_PURPOSE = '${SECRETS_AT_REST_PURPOSE}'`);
  });
});

describe('parseSecretListing', () => {
  const listing = [
    'OTHER=a',
    'SECRET_ENCRYPTION_KEY_WRAPPED=own',
    '',
    '# fallback',
    'SECRET_ENCRYPTION_KEY_WRAPPED=inherited',
  ];

  it('reads the stage value and ignores the fallback section', () => {
    expect(parseSecretListing(listing.join('\n'), 'SECRET_ENCRYPTION_KEY_WRAPPED')).toBe('own');
  });

  it('does not report a fallback-only value as set', () => {
    expect(parseSecretListing(listing.filter(l => l !== listing[1]).join('\n'), 'SECRET_ENCRYPTION_KEY_WRAPPED')).toBe(
      undefined
    );
  });
});
