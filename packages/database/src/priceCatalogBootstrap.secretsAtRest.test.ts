import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROVIDER_RETRY_COOLDOWN_MS,
  decryptAtRest,
  encryptSecret,
  generateEncryptionKey,
  getStageDataKey,
} from '@bike4mind/utils/security';
import { resetKeyringForTests } from '@bike4mind/utils/security/testing';

const KEY = generateEncryptionKey();
const DATA_KEY = Buffer.from(generateEncryptionKey(), 'hex');
const WRAPPED = Buffer.from('blob').toString('base64');

const resource = vi.hoisted(() => ({
  values: {} as Record<string, string | undefined>,
  reads: [] as string[],
  stage: 'test' as string | undefined,
}));
const kms = vi.hoisted(() => ({ decrypt: vi.fn() }));

// Stand in for the SST runtime so this test proves the connectDB seam can source the key
// from Resource - the path a scripts/cron process (which never imports apps/client Config) takes.
vi.mock('sst', () => ({
  Resource: new Proxy(
    {
      get App() {
        return { stage: resource.stage };
      },
    },
    {
      get: (target, name: string) => {
        if (name in target) return target[name as 'App'];
        resource.reads.push(name);
        return { value: resource.values[name] };
      },
    }
  ),
}));
// Route the aws-kms provider's unwrap to a fake instead of a real KMS client.
vi.mock('@bike4mind/utils/security', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils/security')>();
  return {
    ...actual,
    createAwsKmsKeyProvider: (opts: Parameters<typeof actual.createAwsKmsKeyProvider>[0]) =>
      actual.createAwsKmsKeyProvider({ ...opts, decrypt: kms.decrypt }),
  };
});
// connectDB collaborators: only the keyring wiring is under test.
vi.mock('@bike4mind/db-core', () => ({ connectDB: vi.fn().mockResolvedValue('connection') }));
vi.mock('@bike4mind/llm-adapters', () => ({
  setModelPriceRowsProvider: vi.fn(),
  setModelCatalogProvider: vi.fn(),
  setModelListRevisionProvider: vi.fn(),
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn(), info: vi.fn() } }));
vi.mock('./modelListRevision', () => ({ readModelListRevision: vi.fn() }));
vi.mock('./models/billing/ModelPriceModel', () => ({ modelPriceRepository: { rowsInForce: vi.fn() } }));
vi.mock('./models/ai/ModelCatalogModel', () => ({
  modelCatalogRepository: { rowsInForce: vi.fn() },
  ModelCatalog: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./models/ai/ModelDiscoveryStateModel', () => ({
  ModelDiscoveryState: { init: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('./models/ai/DataLakeModel', () => ({ DataLakeModel: { init: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('./seeds/seedModelPrices', () => ({ seedModelPrices: vi.fn().mockResolvedValue({ inserted: 0 }) }));
vi.mock('./seeds/seedModelCatalog', () => ({ seedModelCatalog: vi.fn().mockResolvedValue({ inserted: 0 }) }));

describe('keyring loading from SST resources', () => {
  beforeEach(() => {
    resetKeyringForTests();
    kms.decrypt.mockReset();
    resource.reads = [];
    resource.stage = 'test';
    resource.values = { SECRET_ENCRYPTION_KEY: KEY };
  });

  it('self-host: no wrapped blob selects the static provider and decrypts v1/v2 values', async () => {
    const { ensureKeyringLoaded, selectKeyProvider } = await import('./security/loadKeyringFromResource');
    expect(selectKeyProvider(KEY, () => undefined).name).toBe('static');
    await ensureKeyringLoaded();
    expect(getStageDataKey()?.id).toBe('static');
    expect(decryptAtRest(encryptSecret('sk-secret-from-a-script', KEY))).toBe('sk-secret-from-a-script');
    expect(kms.decrypt).not.toHaveBeenCalled();
  });

  it('a placeholder wrapped blob keeps the stage on the static provider', async () => {
    const { selectKeyProvider } = await import('./security/loadKeyringFromResource');
    expect(selectKeyProvider(KEY, () => 'not-configured').name).toBe('static');
  });

  it('an aws-kms stage with no resolvable app stage throws instead of building an unusable provider', async () => {
    const { selectKeyProvider } = await import('./security/loadKeyringFromResource');
    resource.stage = undefined;
    expect(() => selectKeyProvider(KEY, name => (name === 'SECRET_DATA_KEY_WRAPPED' ? WRAPPED : undefined))).toThrow(
      'app stage is unavailable'
    );
  });

  it('skips Resource reads once the keyring has settled', async () => {
    const { ensureKeyringLoaded } = await import('./security/loadKeyringFromResource');
    await ensureKeyringLoaded();
    resource.reads = [];
    resource.values = { SECRET_DATA_KEY_WRAPPED: WRAPPED };
    await ensureKeyringLoaded();
    expect(resource.reads).toEqual([]);
    expect(kms.decrypt).not.toHaveBeenCalled();
    expect(getStageDataKey()?.id).toBe('static');
  });
});

describe('connectDB keyring wiring', () => {
  const logger = { error: vi.fn() };

  beforeEach(() => {
    resetKeyringForTests();
    kms.decrypt.mockReset();
    logger.error.mockReset();
    resource.values = { SECRET_ENCRYPTION_KEY: KEY, SECRET_DATA_KEY_WRAPPED: WRAPPED };
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => vi.useRealTimers());

  it('loads the keyring on connect, unwrapping with the stage encryption context', async () => {
    kms.decrypt.mockResolvedValue(new Uint8Array(DATA_KEY));
    const { connectDB } = await import('./priceCatalogBootstrap');
    await connectDB('mongodb://x', logger as never);
    await vi.waitFor(() => expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex')));

    expect(kms.decrypt).toHaveBeenCalledTimes(1);
    expect(kms.decrypt).toHaveBeenCalledWith({
      ciphertext: Buffer.from('blob'),
      encryptionContext: { purpose: 'secrets-at-rest', stage: 'test' },
      signal: expect.any(AbortSignal),
    });
    expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex'));
  });

  it('a failed unwrap does not fail the connection, is not cached, and is retried after the cooldown', async () => {
    kms.decrypt.mockRejectedValueOnce(new Error('kms down')).mockResolvedValueOnce(new Uint8Array(DATA_KEY));
    const { connectDB } = await import('./priceCatalogBootstrap');

    await expect(connectDB('mongodb://x', logger as never)).resolves.toBe('connection');
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('keyring load failed'), expect.any(Error));
    expect(getStageDataKey()).toBeNull();
    // v1/v2 keeps working on the static keys meanwhile.
    expect(decryptAtRest(encryptSecret('still-readable', KEY))).toBe('still-readable');

    // Inside the cooldown a connect does not touch KMS again.
    await connectDB('mongodb://x', logger as never);
    await Promise.resolve();
    expect(kms.decrypt).toHaveBeenCalledTimes(1);
    expect(getStageDataKey()).toBeNull();

    vi.setSystemTime(Date.now() + PROVIDER_RETRY_COOLDOWN_MS + 1);
    await connectDB('mongodb://x', logger as never);
    await vi.waitFor(() => expect(getStageDataKey()?.key).toBe(DATA_KEY.toString('hex')));
    expect(kms.decrypt).toHaveBeenCalledTimes(2);

    // Settled: later connects are no-ops.
    await connectDB('mongodb://x', logger as never);
    expect(kms.decrypt).toHaveBeenCalledTimes(2);
  });
});
