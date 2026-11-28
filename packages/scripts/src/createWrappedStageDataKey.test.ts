import { DescribeKeyCommand, GenerateDataKeyWithoutPlaintextCommand, type KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';
import { SECRETS_AT_REST_PURPOSE } from '@bike4mind/common';
import {
  createSstSecretStore,
  createWrappedStageDataKey,
  parseCliOptions,
  parseSecretListing,
  runCli,
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

function cliHarness(enabled = true, blob: Uint8Array | null = BLOB) {
  const exec = vi.fn((_cmd: string, argv: string[]) => (argv[2] === 'list' ? '# x/dev\n' : ''));
  const send = vi.fn(async (command: DescribeKeyCommand | GenerateDataKeyWithoutPlaintextCommand) =>
    command instanceof DescribeKeyCommand
      ? { KeyMetadata: { Enabled: enabled, Arn: 'arn:key' } }
      : { CiphertextBlob: blob ?? undefined }
  );
  return { exec, send, kms: { send } as unknown as Pick<KMSClient, 'send'> };
}

describe('runCli', () => {
  it.each([
    [['--stage', 'dev', '--app', 'flag-app'], { SEED_APP_NAME: 'env-app' }, 'flag-app'],
    [['--stage', 'dev'], { SEED_APP_NAME: 'env-app' }, 'env-app'],
    [['--stage', 'dev'], {}, 'bike4mind'],
  ])('builds the key alias and the sst store from one app name (%j, %j)', async (args, env, app) => {
    const { exec, send, kms } = cliHarness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(args, env, { exec, kms })).toBe('created');
      const alias = `alias/${app}-dev-secrets-at-rest`;
      expect(send.mock.calls[0][0].input.KeyId).toBe(alias);
      const generate = send.mock.calls[1][0];
      expect(generate).toBeInstanceOf(GenerateDataKeyWithoutPlaintextCommand);
      expect(generate.input).toEqual({
        KeyId: alias,
        KeySpec: 'AES_256',
        EncryptionContext: { purpose: SECRETS_AT_REST_PURPOSE, stage: 'dev' },
      });
      expect(exec).toHaveBeenCalledTimes(2);
      for (const call of exec.mock.calls as unknown as [string, string[], { env: NodeJS.ProcessEnv }][]) {
        expect(call[2].env.SEED_APP_NAME).toBe(app);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('sends --key to both KMS calls', async () => {
    const { exec, send, kms } = cliHarness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(['--stage', 'pr1', '--key', 'alias/x'], {}, { exec, kms })).toBe('created');
      expect(send.mock.calls.map(([command]) => command.input.KeyId)).toEqual(['alias/x', 'alias/x']);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('wrapped under arn:key'));
    } finally {
      log.mockRestore();
    }
  });

  it('refuses a disabled key without generating or setting anything', async () => {
    const { exec, send, kms } = cliHarness(false);
    await expect(runCli(['--stage', 'dev'], {}, { exec, kms })).rejects.toThrow('is not enabled');
    expect(send).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty ciphertext blob without setting the secret', async () => {
    const { exec, kms } = cliHarness(true, null);
    await expect(runCli(['--stage', 'dev'], {}, { exec, kms })).rejects.toThrow('no ciphertext blob');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('turns a flag error into a rejection the entry can catch', async () => {
    const { exec, kms } = cliHarness();
    await expect(runCli([], {}, { exec, kms })).rejects.toThrow('--stage is required');
  });
});

describe('parseCliOptions', () => {
  it('requires --stage and flags preview stages', () => {
    expect(() => parseCliOptions([], {})).toThrow('--stage is required');
    expect(parseCliOptions(['--stage', 'pr1'], {}).isPreview).toBe(true);
    expect(parseCliOptions(['--stage', 'pr1', '--key', 'alias/x'], {}).key).toBe('alias/x');
    expect(parseCliOptions(['--stage', 'dev'], { IS_PREVIEW: 'true' }).isPreview).toBe(true);
    expect(parseCliOptions(['--stage', 'production', '--dry-run'], {})).toMatchObject({
      isPreview: false,
      dryRun: true,
    });
  });
});
