import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

const h = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findBySlug: vi.fn(),
  getSettingsValue: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
  createHelpEmbedder: vi.fn(),
  ingestHelpDatalake: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: h.connectDB,
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  apiKeyRepository: {},
  dataLakeRepository: { findBySlug: h.findBySlug },
  fabFileChunkRepository: {},
  fabFileRepository: {},
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    warn = h.loggerWarn;
    error = h.loggerError;
  },
}));
vi.mock('@bike4mind/scripts/help/ingestHelpDatalake', () => ({
  HELP_DATALAKE_SLUG: 'system-help',
  createHelpEmbedder: h.createHelpEmbedder,
  ingestHelpDatalake: h.ingestHelpDatalake,
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: h.getEffectiveLLMApiKeys },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%/db' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'dev' } } }));

import { handler } from './helpDatalakeIngest';

const CLEAN_RESULT = {
  publicEntries: 51,
  unchanged: 51,
  created: 0,
  removed: 0,
  chunksCreated: 0,
  deferred: 0,
  missingContent: [],
};

describe('helpDatalakeIngest cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LAMBDA_TASK_ROOT;
    h.findBySlug.mockResolvedValue({ id: 'lake-1', createdByUserId: 'system-user' });
    h.getSettingsValue.mockResolvedValue('text-embedding-3-small');
    h.getEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-test' });
    // Returns the model it settled on, so a keyless stage's Bedrock fallback reaches the corpus
    // stamp rather than the requested model - see createHelpEmbedder.
    h.createHelpEmbedder.mockReturnValue({ embed: vi.fn(), model: 'text-embedding-3-small' });
    h.ingestHelpDatalake.mockResolvedValue(CLEAN_RESULT);
  });

  it('stamps the corpus with the model the embedder resolved, not the one requested', async () => {
    // A keyless cloud stage falls back to Bedrock. deps.embeddingModel is both the stamp and the
    // re-ingest invalidation key, so echoing the requested model here would label Titan vectors
    // as ada-002 and re-invalidate every member on each 6-hour tick.
    h.getSettingsValue.mockResolvedValue('text-embedding-ada-002');
    h.createHelpEmbedder.mockReturnValue({ embed: vi.fn(), model: 'amazon.titan-embed-text-v2:0' });

    await handler();

    expect(h.ingestHelpDatalake).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: 'amazon.titan-embed-text-v2:0' }),
      expect.anything()
    );
  });

  it('does not bootstrap: with no lake it no-ops instead of creating one under a guessed owner', async () => {
    h.findBySlug.mockResolvedValue(null);

    const res = await handler();

    expect(h.ingestHelpDatalake).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ skipped: 'lake-missing' });
  });

  it('owns the mirrored files as the lake creator, and embeds with that user keys', async () => {
    await handler();

    expect(h.getEffectiveLLMApiKeys).toHaveBeenCalledWith('system-user', expect.anything());
    expect(h.ingestHelpDatalake).toHaveBeenCalledWith(
      expect.objectContaining({ embeddingModel: 'text-embedding-3-small' }),
      expect.objectContaining({ userId: 'system-user' })
    );
  });

  it('reads the corpus copyFiles placed under the Lambda task root', async () => {
    process.env.LAMBDA_TASK_ROOT = '/var/task';

    await handler();

    expect(h.ingestHelpDatalake).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        helpIndexPath: path.join('/var/task', 'help-corpus', 'help-index.json'),
        helpContentRoot: path.join('/var/task', 'help-corpus', 'docs'),
      })
    );
  });

  it('skips rather than embedding with an unusable model when defaultEmbeddingModel is unset', async () => {
    h.getSettingsValue.mockResolvedValue(undefined);

    const res = await handler();

    expect(h.createHelpEmbedder).not.toHaveBeenCalled();
    expect(h.ingestHelpDatalake).not.toHaveBeenCalled();
    expect(JSON.parse(res.body)).toMatchObject({ skipped: 'embedding-model' });
  });

  it('escalates the one drift a re-run cannot close: an indexed article missing from the bundle', async () => {
    h.ingestHelpDatalake.mockResolvedValue({ ...CLEAN_RESULT, missingContent: ['features/data-lakes'] });

    await handler();

    expect(h.loggerError).toHaveBeenCalledWith(expect.stringContaining('missing from the bundled corpus'), {
      slugs: ['features/data-lakes'],
    });
  });

  it('returns the mirror counts so a run reads as converged in the cron log', async () => {
    h.ingestHelpDatalake.mockResolvedValue({ ...CLEAN_RESULT, unchanged: 49, created: 2, removed: 11 });

    const res = await handler();

    expect(JSON.parse(res.body)).toMatchObject({ unchanged: 49, created: 2, removed: 11 });
  });
});
