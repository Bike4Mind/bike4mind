import { describe, it, expect, vi, beforeEach } from 'vitest';
import { allSettingDefinitions } from '@bike4mind/common';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const getSettingsValueWithSource = vi.fn();
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {
    getSettingsValueWithSource: (...args: unknown[]) => getSettingsValueWithSource(...args),
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
    getSettingsValueWithSource.mockReset().mockResolvedValue({ value: undefined, source: 'default' });
  });

  it('masks a sensitive value down to its last 4 characters', async () => {
    const secret = 'sk-live-abcdefghijklmnop1234';
    getSettingsValueWithSource.mockResolvedValue({ value: secret, source: 'stored' });

    const raw = await getSettingTool.implementation(context, undefined).toolFn({ key: 'openaiDemoKey' });
    const result = JSON.parse(raw);

    expect(raw).not.toContain(secret);
    expect(result.data).toMatchObject({
      key: 'openaiDemoKey',
      isSensitive: true,
      value: '********1234',
      source: 'stored',
    });
  });

  it('reads the effective value of a stored setting', async () => {
    getSettingsValueWithSource.mockResolvedValue({ value: false, source: 'stored' });

    const result = await runTool({ key: 'enforceCredits' });

    expect(getSettingsValueWithSource).toHaveBeenCalledWith('enforceCredits');
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
        source: 'stored',
        overridableAt: [],
      },
    });
  });

  it('passes through the source the repository reports', async () => {
    getSettingsValueWithSource.mockResolvedValue({ value: true, source: 'locked' });

    expect((await runTool({ key: 'enforceCredits' })).data).toMatchObject({ value: true, source: 'locked' });
  });

  it('lists the scopes that can override a scopable setting', async () => {
    const scopable = allSettingDefinitions().find(definition => definition.scope?.settableAt?.length);
    expect(scopable).toBeDefined();

    const result = await runTool({ key: scopable!.key });

    expect(result.data.overridableAt).toEqual(scopable!.scope!.settableAt);
  });

  it('returns null rather than dropping the value when nothing resolves', async () => {
    const raw = await getSettingTool.implementation(context, undefined).toolFn({ key: 'enforceCredits' });
    expect(JSON.parse(raw).data).toMatchObject({ value: null, truncatedPreview: null });
  });

  it('sends a truncated JSON preview instead of a very large value', async () => {
    const huge = 'x'.repeat(10_000);
    getSettingsValueWithSource.mockResolvedValue({ value: huge, source: 'stored' });

    const result = await runTool({ key: 'enforceCredits' });

    expect(result.data.value).toBeNull();
    expect(result.data.truncatedPreview).toHaveLength(4_000);
  });

  it('returns not_found for an unknown key without reading the database', async () => {
    expect(await runTool({ key: 'noSuchSetting' })).toMatchObject({ ok: false, error: 'not_found' });
    expect(getSettingsValueWithSource).not.toHaveBeenCalled();
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
    expect(getSettingsValueWithSource).not.toHaveBeenCalled();
  });

  it('matches every search word anywhere, not the phrase as typed', async () => {
    const result = await runTool({ search: 'credits enforce' });

    expect(result.data.settings.map((setting: { key: string }) => setting.key)).toContain('enforceCredits');
  });

  it('caps search results at 20 and flags the cut', async () => {
    const result = await runTool({ search: 'the' });

    expect(result.data.settings).toHaveLength(20);
    expect(result.data.truncated).toBe(true);
  });

  it('treats an empty parameter as omitted', async () => {
    expect(await runTool({ key: 'enforceCredits', search: '' })).toMatchObject({ ok: true });
    expect(await runTool({ key: '', search: 'openai' })).toMatchObject({ ok: true });
  });

  it('advertises both parameters as plain optional strings', () => {
    const { parameters } = getSettingTool.implementation(context, undefined).toolSchema;

    expect(parameters.required ?? []).toEqual([]);
    expect(parameters.properties).toMatchObject({ key: { type: 'string' }, search: { type: 'string' } });
  });

  it('requires exactly one of key or search', async () => {
    expect(await runTool({})).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await runTool({ key: '', search: '  ' })).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(await runTool({ key: 'enforceCredits', search: 'credits' })).toMatchObject({
      ok: false,
      error: 'invalid_input',
    });
  });
});
