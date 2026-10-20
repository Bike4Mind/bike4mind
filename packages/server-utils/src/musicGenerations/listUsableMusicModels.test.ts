import { describe, expect, it, vi } from 'vitest';
import {
  MUSIC_MODEL_CATALOG,
  PublicMusicModelSchema,
  usdToCredits,
  type MusicModelId,
  type MusicProviderId,
} from '@bike4mind/common';
import { createMusicProviderRegistry, TestMusicProvider, type MusicProvider } from '@bike4mind/utils/musicProviders';
import { listUsableMusicModels, toPublicMusicModel } from './listUsableMusicModels';

// The listing only needs registered providers that serve their catalog models; no real adapter is exercised.
const fakeProvider = (id: Exclude<MusicProviderId, 'test'>): MusicProvider =>
  ({
    id,
    models: (Object.keys(MUSIC_MODEL_CATALOG) as MusicModelId[]).filter(
      model => MUSIC_MODEL_CATALOG[model].provider === id
    ),
    submit: vi.fn(),
    poll: vi.fn(),
    fetchOutput: vi.fn(),
  }) as unknown as MusicProvider;

const deps = (
  overrides: {
    enabled?: Record<string, boolean>;
    keys?: Partial<Record<MusicProviderId, string | null>>;
    withTest?: boolean;
    withElevenLabs?: boolean;
  } = {}
) => ({
  providers: createMusicProviderRegistry([
    fakeProvider('gemini-lyria'),
    ...(overrides.withElevenLabs ? [fakeProvider('elevenlabs')] : []),
    ...(overrides.withTest ? [new TestMusicProvider()] : []),
  ]),
  getSettings: vi.fn(async () => ({
    enforceCredits: true,
    musicGeneration: { enabledModels: overrides.enabled ?? {} },
  })),
  resolveApiKey: vi.fn(async (providerId: MusicProviderId, _userId: string) =>
    overrides.keys?.[providerId] === undefined ? 'k' : overrides.keys[providerId]
  ),
});

describe('toPublicMusicModel', () => {
  it('maps a fixed-duration, per-song, lyrics-without-line-cap model', () => {
    const model = toPublicMusicModel('lyria-3-clip-preview');
    expect(PublicMusicModelSchema.parse(model)).toEqual(model);
    expect(model).toMatchObject({
      object: 'music_model',
      provider: 'gemini-lyria',
      duration: { control: 'fixed', seconds: 30 },
      pricing: { unit: 'per_song', credits: usdToCredits(0.04) },
      preview: true,
      deprecation_date: null,
    });
    expect(model.lyrics).toEqual({
      max_chars: MUSIC_MODEL_CATALOG['lyria-3-clip-preview'].lyrics?.maxChars,
      max_line_chars: null,
    });
    expect(model.duration).not.toHaveProperty('min');
  });

  it('maps an approximate duration with its range and default', () => {
    expect(toPublicMusicModel('lyria-3.5').duration).toEqual({
      control: 'approximate',
      min: 30,
      max: 180,
      default: 120,
    });
  });

  it('maps an exact duration, a per-second price and a lyrics line cap', () => {
    const model = toPublicMusicModel('music_v2_5');
    expect(model.duration).toEqual({ control: 'exact', min: 3, max: 300, default: 60 });
    expect(model.pricing).toEqual({ unit: 'per_second', credits: usdToCredits(0.15 / 60) });
    expect(model.lyrics).toMatchObject({ max_line_chars: 200 });
    expect(PublicMusicModelSchema.parse(model)).toEqual(model);
  });

  it('copies output formats rather than sharing the catalog array', () => {
    const model = toPublicMusicModel('lyria-3.5');
    expect(model.output_formats).toEqual(['mp3']);
    expect(model.output_formats).not.toBe(MUSIC_MODEL_CATALOG['lyria-3.5'].outputFormats);
  });
});

describe('listUsableMusicModels', () => {
  it('lists enabled, registered models with a usable key, in catalog order', async () => {
    const models = await listUsableMusicModels('u1', deps({ withTest: true }));
    expect(models.map(m => m.id)).toEqual(['test-music', 'lyria-3.5', 'lyria-3-clip-preview']);
    for (const model of models) expect(PublicMusicModelSchema.parse(model)).toEqual(model);
  });

  it('omits an unregistered provider, a disabled model and a provider without a key', async () => {
    expect((await listUsableMusicModels('u1', deps())).map(m => m.id)).toEqual(['lyria-3.5', 'lyria-3-clip-preview']);
    expect((await listUsableMusicModels('u1', deps({ enabled: { 'lyria-3.5': false } }))).map(m => m.id)).toEqual([
      'lyria-3-clip-preview',
    ]);
    expect(await listUsableMusicModels('u1', deps({ keys: { 'gemini-lyria': null } }))).toEqual([]);
    expect(
      (await listUsableMusicModels('u1', deps({ withTest: true, keys: { 'gemini-lyria': null } }))).map(m => m.id)
    ).toEqual(['test-music']);
  });

  it('lists a model that is off by default only when an admin enables it', async () => {
    expect((await listUsableMusicModels('u1', deps({ withElevenLabs: true }))).map(m => m.id)).not.toContain(
      'music_v1'
    );
    const enabled = await listUsableMusicModels('u1', deps({ withElevenLabs: true, enabled: { music_v1: true } }));
    expect(enabled.map(m => m.id)).toContain('music_v1');
  });

  it('resolves one key per provider, and none for a provider whose models are all disabled', async () => {
    const d = deps({ withElevenLabs: true, enabled: { music_v2_5: false, music_v2: false } });
    await listUsableMusicModels('u1', d);
    expect(d.resolveApiKey).toHaveBeenCalledTimes(1);
    expect(d.resolveApiKey).toHaveBeenCalledWith('gemini-lyria', 'u1');
  });

  it('asks for the key once per provider however many of its models are listed', async () => {
    const d = deps({ withElevenLabs: true });
    await listUsableMusicModels('u1', d);
    expect(d.resolveApiKey).toHaveBeenCalledTimes(2);
  });
});
