import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { FallbackLakeSetting, fallbackLakeSettingsRepository } from './FallbackLakeSettingModel';

/**
 * Real-Mongo guard for the fallback-lake settings overlay: a hand-mocked repo cannot exercise the
 * unique index on `lakeId`, and the upsert-by-lakeId semantics `setFields` depends on are exactly
 * what only a real index/query catches.
 */
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await FallbackLakeSetting.init();
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await FallbackLakeSetting.deleteMany({});
});

describe('FallbackLakeSettingModel - unique index on lakeId', () => {
  it('rejects a second row at the same lakeId created directly (bypassing the repository)', async () => {
    await FallbackLakeSetting.create({ lakeId: 'opti-knowledge', groundingMode: 'retrieve' });
    await expect(
      FallbackLakeSetting.create({ lakeId: 'opti-knowledge', groundingMode: 'inline' })
    ).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('a different lakeId is a separate row', async () => {
    await FallbackLakeSetting.create({ lakeId: 'opti-knowledge', groundingMode: 'retrieve' });
    await expect(FallbackLakeSetting.create({ lakeId: 'other-lake', groundingMode: 'inline' })).resolves.toBeTruthy();
  });
});

describe('fallbackLakeSettingsRepository.setFields - upsert by lakeId', () => {
  it('creates a row on first call', async () => {
    const result = await fallbackLakeSettingsRepository.setFields('opti-knowledge', { groundingMode: 'inline' });
    expect(result.lakeId).toBe('opti-knowledge');
    expect(result.groundingMode).toBe('inline');

    const rows = await FallbackLakeSetting.find({ lakeId: 'opti-knowledge' });
    expect(rows).toHaveLength(1);
  });

  it('updates the SAME row on a second call, never creating a duplicate', async () => {
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', { groundingMode: 'inline' });
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', { groundingMode: 'auto-by-size' });

    const rows = await FallbackLakeSetting.find({ lakeId: 'opti-knowledge' });
    expect(rows).toHaveLength(1);
    expect(rows[0].groundingMode).toBe('auto-by-size');
  });

  it('setting ONE field leaves an already-stored sibling field untouched', async () => {
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', {
      groundingMode: 'inline',
      preferredSystemPromptId: 'triage_router',
    });
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', { groundingMode: 'retrieve' });

    const row = await fallbackLakeSettingsRepository.findByLakeId('opti-knowledge');
    expect(row?.groundingMode).toBe('retrieve');
    expect(row?.preferredSystemPromptId).toBe('triage_router');
  });

  it('can set both fields together in one call', async () => {
    const result = await fallbackLakeSettingsRepository.setFields('opti-knowledge', {
      groundingMode: 'auto-by-size',
      preferredSystemPromptId: 'triage_router',
    });
    expect(result.groundingMode).toBe('auto-by-size');
    expect(result.preferredSystemPromptId).toBe('triage_router');
  });

  it('an explicit empty-string preferredSystemPromptId clears a previously-stored one', async () => {
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', { preferredSystemPromptId: 'triage_router' });
    await fallbackLakeSettingsRepository.setFields('opti-knowledge', { preferredSystemPromptId: '' });

    const row = await fallbackLakeSettingsRepository.findByLakeId('opti-knowledge');
    expect(row?.preferredSystemPromptId).toBeFalsy();
  });
});

describe('fallbackLakeSettingsRepository.findByLakeId / findByLakeIds', () => {
  it('findByLakeId returns null for a lake with no row', async () => {
    expect(await fallbackLakeSettingsRepository.findByLakeId('never-configured')).toBeNull();
  });

  it('findByLakeIds batches multiple lakes in one query and skips unconfigured ones', async () => {
    await fallbackLakeSettingsRepository.setFields('lake-a', { groundingMode: 'inline' });
    await fallbackLakeSettingsRepository.setFields('lake-b', { groundingMode: 'retrieve' });

    const rows = await fallbackLakeSettingsRepository.findByLakeIds(['lake-a', 'lake-b', 'lake-c-never-configured']);
    expect(rows.map(r => r.lakeId).sort()).toEqual(['lake-a', 'lake-b']);
  });

  it('findByLakeIds returns nothing for an empty id list', async () => {
    await fallbackLakeSettingsRepository.setFields('lake-a', { groundingMode: 'inline' });
    expect(await fallbackLakeSettingsRepository.findByLakeIds([])).toEqual([]);
  });
});
