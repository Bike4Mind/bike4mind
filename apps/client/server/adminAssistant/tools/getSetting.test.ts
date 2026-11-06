import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const findOne = vi.fn();
const getSettingsValue = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    findOne: (...args: unknown[]) => findOne(...args),
    getSettingsValue: (...args: unknown[]) => getSettingsValue(...args),
  },
}));

import { getSettingTool } from './getSetting';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runTool = async (args: unknown) =>
  JSON.parse(await getSettingTool.implementation(context, undefined).toolFn(args));

describe('getSettingTool', () => {
  beforeEach(() => {
    findOne.mockReset().mockResolvedValue(null);
    getSettingsValue.mockReset().mockResolvedValue(undefined);
  });

  it('masks a sensitive value down to its last 4 characters', async () => {
    const secret = 'sk-live-abcdefghijklmnop1234';
    findOne.mockResolvedValue({ settingName: 'openaiDemoKey', settingValue: secret });
    getSettingsValue.mockResolvedValue(secret);

    const raw = await getSettingTool.implementation(context, undefined).toolFn({ key: 'openaiDemoKey' });
    const result = JSON.parse(raw);

    expect(raw).not.toContain(secret);
    expect(result.data).toMatchObject({
      key: 'openaiDemoKey',
      isSensitive: true,
      value: '********1234',
      usingDefault: false,
    });
  });

  it('reads the effective value of a stored setting', async () => {
    findOne.mockResolvedValue({ settingName: 'enforceCredits', settingValue: false });
    getSettingsValue.mockResolvedValue(false);

    const result = await runTool({ key: 'enforceCredits' });

    expect(getSettingsValue).toHaveBeenCalledWith('enforceCredits');
    expect(result).toEqual({
      ok: true,
      data: {
        key: 'enforceCredits',
        name: 'Enforce Credits',
        category: 'Users',
        description: 'Whether to enforce credits for users',
        type: 'boolean',
        isSensitive: false,
        value: false,
        truncatedPreview: null,
        usingDefault: false,
      },
    });
  });

  it('flags the default when no row is stored or the stored value fails the schema', async () => {
    getSettingsValue.mockResolvedValue(true);
    expect((await runTool({ key: 'enforceCredits' })).data).toMatchObject({ value: true, usingDefault: true });

    findOne.mockResolvedValue({ settingName: 'enforceCredits', settingValue: 'not-a-boolean' });
    expect((await runTool({ key: 'enforceCredits' })).data).toMatchObject({ value: true, usingDefault: true });
  });

  it('sends a truncated JSON preview instead of a very large value', async () => {
    const huge = 'x'.repeat(10_000);
    getSettingsValue.mockResolvedValue(huge);

    const result = await runTool({ key: 'enforceCredits' });

    expect(result.data.value).toBeNull();
    expect(result.data.truncatedPreview).toHaveLength(4_000);
  });

  it('returns not_found for an unknown key without reading the database', async () => {
    expect(await runTool({ key: 'noSuchSetting' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(findOne).not.toHaveBeenCalled();
    expect(getSettingsValue).not.toHaveBeenCalled();
  });

  it('searches definitions case-insensitively and returns keys without values', async () => {
    const result = await runTool({ search: 'openai api KEY' });

    expect(result.ok).toBe(true);
    expect(result.data.settings).toContainEqual({
      key: 'openaiDemoKey',
      name: 'OpenAI API Key',
      category: 'AI',
      description: 'The global API Key for OpenAI.',
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('caps search results at 20 and flags the cut', async () => {
    const result = await runTool({ search: 'the' });

    expect(result.data.settings).toHaveLength(20);
    expect(result.data.truncated).toBe(true);
  });

  it('requires exactly one of key or search', async () => {
    expect(await runTool({})).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await runTool({ key: 'enforceCredits', search: 'credits' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });
});
