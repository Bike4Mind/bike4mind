import { describe, expect, it, vi } from 'vitest';
import { settingsMap } from '@bike4mind/common';
import {
  PREVIEW_SETTINGS,
  formatHelp,
  formatOutcomes,
  isUnchanged,
  parseSeedArgs,
  planSeed,
  previewBaseUrl,
  redactSecrets,
  resolvePreviewStage,
  runSeed,
  type SettingsClient,
} from './seedPreviewSettings';

const FAKE_OPENAI = 'fake-openai-value-0000-abcd';
const FAKE_WEATHER = 'fake-weather-value-1111-wxyz';
const mask = (value: string) => `********${value.slice(-4)}`;

describe('resolvePreviewStage', () => {
  it.each(['1', '42', '7694'])('accepts --pr %s', pr => {
    expect(resolvePreviewStage({ pr })).toBe(`pr${pr}`);
  });

  it('accepts a pr<N> stage', () => {
    expect(resolvePreviewStage({ stage: 'pr7694' })).toBe('pr7694');
  });

  it.each([
    'dev',
    'staging',
    'production',
    'prod',
    'previews',
    'pr',
    'pr0',
    'pr01',
    'pr12a',
    'PR12',
    'pr-12',
    'pr12.evil',
  ])('refuses stage %s', stage => {
    expect(() => resolvePreviewStage({ stage })).toThrow(/Refusing stage/);
  });

  it.each(['0', '-1', 'abc', '1e3', '12 13'])('refuses --pr %j', pr => {
    expect(() => resolvePreviewStage({ pr })).toThrow(/Refusing stage/);
  });

  it('requires a target and refuses both at once', () => {
    expect(() => resolvePreviewStage({})).toThrow(/target is required/);
    expect(() => resolvePreviewStage({ pr: '1', stage: 'pr1' })).toThrow(/not both/);
  });

  it('builds the preview URL only for a preview stage', () => {
    expect(previewBaseUrl('pr7694')).toBe('https://app.pr7694.preview.bike4mind.com');
    expect(() => previewBaseUrl('production')).toThrow(/Refusing stage/);
  });
});

describe('parseSeedArgs', () => {
  it('parses a full command line', () => {
    expect(parseSeedArgs(['--pr', '12', '--only', 'openaiDemoKey, OpenWeatherKey', '--dry-run', '--force'])).toEqual({
      help: false,
      stage: 'pr12',
      only: ['openaiDemoKey', 'OpenWeatherKey'],
      dryRun: true,
      force: true,
    });
  });

  it('refuses an unknown --only key and positional values', () => {
    expect(() => parseSeedArgs(['--pr', '12', '--only', 'openaiDemoKey,notASetting'])).toThrow(/notASetting/);
    expect(() => parseSeedArgs(['--pr', '12', 'sk-something'])).toThrow();
  });

  it('refuses a non-preview stage before anything else happens', () => {
    expect(() => parseSeedArgs(['--stage', 'dev'])).toThrow(/Refusing stage "dev"/);
  });
});

describe('PREVIEW_SETTINGS mapping', () => {
  it('names only registered settings, each once', () => {
    const keys = PREVIEW_SETTINGS.map(setting => setting.settingKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(settingsMap, key).toHaveProperty(key);
  });

  it('maps env vars only onto sensitive settings, so the server encrypts and masks them', () => {
    for (const setting of PREVIEW_SETTINGS.filter(entry => entry.kind === 'secret')) {
      const definition = settingsMap[setting.settingKey as keyof typeof settingsMap] as { isSensitive?: boolean };
      expect(definition.isSensitive, setting.settingKey).toBe(true);
    }
  });

  it('gives toggles a value their setting schema accepts', () => {
    for (const setting of PREVIEW_SETTINGS) {
      if (setting.kind !== 'toggle') continue;
      const definition = settingsMap[setting.settingKey as keyof typeof settingsMap] as {
        schema: { safeParse(v: unknown): { success: boolean } };
      };
      expect(definition.schema.safeParse(setting.value).success, setting.settingKey).toBe(true);
    }
  });

  it('lists every env var in --help', () => {
    const help = formatHelp();
    for (const setting of PREVIEW_SETTINGS) {
      expect(help).toContain(setting.settingKey);
      if (setting.kind === 'secret') for (const envVar of setting.envVars) expect(help).toContain(envVar);
    }
  });
});

describe('planSeed', () => {
  it('maps set env vars, skips unset or blank ones, and keeps toggles', () => {
    const { writes, skips } = planSeed({ OPENAI_API_KEY: ` ${FAKE_OPENAI} `, ANTHROPIC_API_KEY: '   ' });
    expect(writes).toContainEqual({
      settingKey: 'openaiDemoKey',
      value: FAKE_OPENAI,
      source: 'OPENAI_API_KEY',
      isSecret: true,
    });
    expect(writes).toContainEqual({
      settingKey: 'EnableWeatherService',
      value: true,
      source: 'toggle',
      isSecret: false,
    });
    expect(skips).toContainEqual({ settingKey: 'anthropicDemoKey', reason: 'not set (ANTHROPIC_API_KEY)' });
    expect(writes.filter(write => write.isSecret)).toHaveLength(1);
  });

  it('falls back to the alias env var in order', () => {
    const { writes } = planSeed({ GOOGLE_API_KEY: 'fake-google-value-9' }, ['geminiDemoKey']);
    expect(writes).toEqual([
      { settingKey: 'geminiDemoKey', value: 'fake-google-value-9', source: 'GOOGLE_API_KEY', isSecret: true },
    ]);
  });

  it('skips a value that the update route would read as a mask', () => {
    const { writes, skips } = planSeed({ OPENAI_API_KEY: '********abcd' }, ['openaiDemoKey']);
    expect(writes).toEqual([]);
    expect(skips[0].reason).toMatch(/masked value/);
    expect(skips[0].reason).not.toContain('abcd');
  });

  it('honours --only', () => {
    const { writes, skips } = planSeed({ OPENAI_API_KEY: FAKE_OPENAI }, ['OpenWeatherKey']);
    expect(writes).toEqual([]);
    expect(skips.map(skip => skip.settingKey)).toEqual(['OpenWeatherKey']);
  });
});

describe('isUnchanged', () => {
  const secret = { settingKey: 'openaiDemoKey', value: FAKE_OPENAI, source: 'OPENAI_API_KEY', isSecret: true };

  it('matches a stored secret by its mask', () => {
    expect(isUnchanged(secret, mask(FAKE_OPENAI))).toBe(true);
    expect(isUnchanged(secret, '********zzzz')).toBe(false);
    expect(isUnchanged(secret, undefined)).toBe(false);
  });

  it('always rewrites a secret too short to carry a last-4', () => {
    expect(isUnchanged({ ...secret, value: 'short' }, '********')).toBe(false);
  });

  it('compares toggles by value', () => {
    const toggle = { settingKey: 'EnableWeatherService', value: true, source: 'toggle', isSecret: false };
    expect(isUnchanged(toggle, true)).toBe(true);
    expect(isUnchanged(toggle, 'true')).toBe(true);
    expect(isUnchanged(toggle, false)).toBe(false);
  });
});

function fakeClient(
  stored: Record<string, unknown>,
  failOn?: string
): SettingsClient & { write: ReturnType<typeof vi.fn> } {
  return {
    readStoredValues: vi.fn(async () => new Map(Object.entries(stored))),
    write: vi.fn(async (key: string, value: boolean | string) => {
      if (key === failOn) throw new Error(`HTTP 400: rejected ${String(value)}`);
      return typeof value === 'string' ? mask(value) : value;
    }),
  };
}

describe('runSeed', () => {
  const env = { OPENAI_API_KEY: FAKE_OPENAI, OPENWEATHER_API_KEY: FAKE_WEATHER };

  it('sets changed values, leaves matching ones, and reports skips', async () => {
    const client = fakeClient({ openaiDemoKey: mask(FAKE_OPENAI), EnableWeatherService: false });
    const outcomes = await runSeed({ env, dryRun: false, force: false, client });

    expect(client.write).toHaveBeenCalledTimes(2);
    expect(client.write).toHaveBeenCalledWith('OpenWeatherKey', FAKE_WEATHER);
    expect(client.write).toHaveBeenCalledWith('EnableWeatherService', true);
    expect(outcomes).toContainEqual({ settingKey: 'openaiDemoKey', status: 'unchanged', source: 'OPENAI_API_KEY' });
    expect(outcomes).toContainEqual({ settingKey: 'OpenWeatherKey', status: 'set', source: 'OPENWEATHER_API_KEY' });
    expect(outcomes.find(outcome => outcome.settingKey === 'anthropicDemoKey')?.status).toBe('skipped');
  });

  it('is idempotent: a second run against the written state changes nothing', async () => {
    const client = fakeClient({
      openaiDemoKey: mask(FAKE_OPENAI),
      OpenWeatherKey: mask(FAKE_WEATHER),
      EnableWeatherService: true,
    });
    const outcomes = await runSeed({ env, dryRun: false, force: false, client });
    expect(client.write).not.toHaveBeenCalled();
    expect(outcomes.filter(outcome => outcome.status === 'unchanged')).toHaveLength(3);
  });

  it('--force re-sends secrets but not toggles that already match', async () => {
    const client = fakeClient({ openaiDemoKey: mask(FAKE_OPENAI), EnableWeatherService: true });
    await runSeed({ env, only: ['openaiDemoKey', 'EnableWeatherService'], dryRun: false, force: true, client });
    expect(client.write).toHaveBeenCalledTimes(1);
    expect(client.write).toHaveBeenCalledWith('openaiDemoKey', FAKE_OPENAI);
  });

  it('dry run touches no client and reports would-set', async () => {
    const outcomes = await runSeed({ env, only: ['openaiDemoKey'], dryRun: true, force: false });
    expect(outcomes).toEqual([{ settingKey: 'openaiDemoKey', status: 'would-set', source: 'OPENAI_API_KEY' }]);
  });

  it('records a failure with the secret redacted and carries on', async () => {
    const client = fakeClient({}, 'openaiDemoKey');
    const outcomes = await runSeed({ env, dryRun: false, force: false, client });
    const failed = outcomes.find(outcome => outcome.settingKey === 'openaiDemoKey');
    expect(failed).toMatchObject({ status: 'failed', reason: 'HTTP 400: rejected [redacted]' });
    expect(outcomes.find(outcome => outcome.settingKey === 'OpenWeatherKey')?.status).toBe('set');
  });

  it('fails a write whose echo does not match', async () => {
    const client = fakeClient({});
    client.write.mockResolvedValueOnce('********nope');
    const outcomes = await runSeed({ env, only: ['openaiDemoKey'], dryRun: false, force: false, client });
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: /did not echo/ });
  });

  it('never puts a secret value in the printed report', async () => {
    const client = fakeClient({}, 'OpenWeatherKey');
    const report = formatOutcomes('pr12', await runSeed({ env, dryRun: false, force: false, client }));
    expect(report).not.toContain(FAKE_OPENAI);
    expect(report).not.toContain(FAKE_WEATHER);
    expect(report).not.toContain(FAKE_OPENAI.slice(-4));
    expect(report).toMatch(/Summary: 2 set, 1 failed, 13 skipped/);
  });
});

describe('redactSecrets', () => {
  it('leaves toggle values alone', () => {
    const writes = [{ settingKey: 'EnableWeatherService', value: true, source: 'toggle', isSecret: false }];
    expect(redactSecrets('value true is fine', writes)).toBe('value true is fine');
  });
});
