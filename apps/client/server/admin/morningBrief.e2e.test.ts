import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { AdminAiClassModel, AdminSettings } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const provider = vi.hoisted(() => vi.fn());
vi.mock('./ai/runAdminAi', () => ({ adminAiTextOutputSchema: {}, runAdminAi: provider }));
vi.mock('./actionCounts', () => ({ computeAdminActionCounts: vi.fn(), computeAdminActionOldest: vi.fn() }));
vi.mock('../security/incidentSignals', () => ({ getAlarms: vi.fn() }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlackWithOutcome: vi.fn() }));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({
    adminAiConfig: (await AdminSettings.findOne({ settingName: 'adminAiConfig' }).lean())?.settingValue,
  }),
  getSettingsValue: (_key: string, settings: { adminAiConfig?: unknown }) => settings.adminAiConfig,
}));
import { morningBriefDeps } from './morningBrief';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
const key = { feature: 'morningBrief', actionClass: 'summary', policyVersion: 'v1' };
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all((await mongoose.connection.db!.collections()).map(collection => collection.deleteMany({})));
  vi.clearAllMocks();
});

describe('brief with real persisted readiness', () => {
  it('requires matching replay evidence and live switches before publishing', async () => {
    await AdminSettings.create({
      settingName: 'adminAiConfig',
      settingValue: { enabled: true, features: { morningBrief: { mode: 'recommend' } } },
    });
    expect(await morningBriefDeps.summarize('dev:2026-11-12', 'Feedback: 3')).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    await AdminAiClassModel.create({
      ...key,
      mode: 'recommend',
      replayCases: 199,
      replayAgreed: 199,
      replayArtifact: 'replay-v1',
    });
    expect(await morningBriefDeps.summarize('dev:2026-11-12', 'Feedback: 3')).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    await AdminAiClassModel.updateOne(key, { $set: { replayCases: 200, replayAgreed: 180 } });
    provider.mockResolvedValue({ ok: true, suggestion: { verdict: 'Review feedback.' } });
    expect(await morningBriefDeps.summarize('dev:2026-11-12', 'Feedback: 3')).toBe('Review feedback.');
    await AdminSettings.updateOne({ settingName: 'adminAiConfig' }, { $set: { 'settingValue.enabled': false } });
    expect(await morningBriefDeps.summarize('dev:2026-11-12', 'Feedback: 3')).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
