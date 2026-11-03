import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { TTS_DEFAULT_MODEL } from '@bike4mind/common';
import { AdminSettings, adminSettingsRepository } from '@bike4mind/database';
import { isFreeTierModel, loadFreeTierAllowedModels } from '@bike4mind/services/llm/modelAdmission';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921237400_allow-gpt-4o-mini-tts-where-tts-1-is-free';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await AdminSettings.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  invalidateSettingsCache();
});

// Raw driver: these are pre-migration rows in the stored JSON-string shape.
const seedGate = async (allowedModels: string[]) => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('no db connection');
  await db.collection('adminsettings').insertMany([
    { settingName: 'freeTierModelGateEnabled', settingValue: 'true', deletedAt: null },
    { settingName: 'freeTierAllowedModels', settingValue: JSON.stringify(allowedModels), deletedAt: null },
  ]);
};

const admitsOpenAiTtsDefault = async () => {
  const allowed = await loadFreeTierAllowedModels(adminSettingsRepository);
  if (!allowed) throw new Error('free-tier gate unexpectedly off');
  return isFreeTierModel(TTS_DEFAULT_MODEL.openai, allowed);
};

describe('allow-gpt-4o-mini-tts-where-tts-1-is-free', () => {
  it('keeps TTS free on the gated path where an admin allowlisted tts-1', async () => {
    await seedGate(['cheap-text', 'tts-1']);
    expect(await admitsOpenAiTtsDefault()).toBe(false);

    await migration.up();
    await migration.up();
    // The loader reads through the in-process settings cache, which the read above primed.
    invalidateSettingsCache();

    expect(await admitsOpenAiTtsDefault()).toBe(true);
    const allowed = await loadFreeTierAllowedModels(adminSettingsRepository);
    expect([...(allowed ?? [])]).toEqual(['cheap-text', 'tts-1', TTS_DEFAULT_MODEL.openai]);
  });

  it('leaves TTS paid-only where tts-1 was never free', async () => {
    await seedGate(['cheap-text']);

    await migration.up();

    expect(await admitsOpenAiTtsDefault()).toBe(false);
  });
});
