// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep @bike4mind/common real so we assert against the actual settingsMap default; mock only
// the infra + middleware seams. AdminSettings.find(...).lean() returns whatever we stage below.
let stored: Array<Record<string, unknown>> = [];
vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: { find: () => ({ lean: () => Promise.resolve(stored) }) },
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ get: (handler: (...a: unknown[]) => unknown) => handler }),
}));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  ensurePublicSettingsArtifactOncePerInstance: vi.fn(() => Promise.resolve()),
}));

import handler from '../fetch';
import { SENSITIVE_SETTING_MASK, settingsMap } from '@bike4mind/common';

const runHandler = async () => {
  const json = vi.fn((x: unknown) => x);
  const req = { user: { isAdmin: true }, logger: { info: vi.fn(), error: vi.fn() } };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, { json });
  return json.mock.calls[0][0] as Array<{ settingName: string; settingValue: unknown }>;
};

describe('settings/fetch defaultEmbeddingModel server-resolved default', () => {
  beforeEach(() => {
    stored = [];
    vi.clearAllMocks();
  });

  it('surfaces the server-resolved default when no admin override is stored', async () => {
    const result = await runHandler();
    const entry = result.filter(s => s.settingName === 'defaultEmbeddingModel');
    expect(entry).toHaveLength(1);
    expect(entry[0].settingValue).toBe(settingsMap.defaultEmbeddingModel.defaultValue);
  });

  it('does not override a stored admin value (no duplicate entry)', async () => {
    stored = [{ settingName: 'defaultEmbeddingModel', settingValue: 'text-embedding-3-large' }];
    const result = await runHandler();
    const entry = result.filter(s => s.settingName === 'defaultEmbeddingModel');
    expect(entry).toHaveLength(1);
    expect(entry[0].settingValue).toBe('text-embedding-3-large');
  });
});

describe('settings/fetch sensitive value redaction', () => {
  beforeEach(() => {
    stored = [];
    vi.clearAllMocks();
  });

  const sensitiveKeys = (Object.values(settingsMap) as Array<{ key: string; isSensitive?: boolean }>)
    .filter(s => s.isSensitive === true)
    .map(s => s.key);

  it('never returns a stored value for any isSensitive setting', async () => {
    expect(sensitiveKeys.length).toBeGreaterThan(0);
    stored = sensitiveKeys.map(key => ({ settingName: key, settingValue: `sk-live-${key}-tail` }));

    const result = await runHandler();
    const serialized = JSON.stringify(result);

    for (const key of sensitiveKeys) {
      const entry = result.find(s => s.settingName === key);
      expect(entry?.settingValue).toBe(`${SENSITIVE_SETTING_MASK}tail`);
      expect(serialized).not.toContain(`sk-live-${key}-tail`);
    }
  });

  it('still returns non-sensitive values in full', async () => {
    stored = [{ settingName: 'enforceMFA', settingValue: 'true' }];
    const result = await runHandler();
    expect(result.find(s => s.settingName === 'enforceMFA')?.settingValue).toBe('true');
  });

  it('reports an unconfigured sensitive setting as empty, not as a mask', async () => {
    stored = [{ settingName: 'anthropicDemoKey', settingValue: '' }];
    const result = await runHandler();
    expect(result.find(s => s.settingName === 'anthropicDemoKey')?.settingValue).toBe('');
  });
});
