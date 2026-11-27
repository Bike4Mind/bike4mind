import { describe, expect, it, vi } from 'vitest';
import { IMAGE_MODEL_CATALOG, IMAGE_PROVIDER_LABELS, ImageModels, type ImageProviderId } from '@bike4mind/common';
import { listUsableImageModels, type ImageModelAvailabilityDeps } from './listUsableImageModels';

type KeyAnswers = Partial<Record<ImageProviderId, string | null>>;

const offer = (id: string, extra: { name?: string; deprecationDate?: string } = {}) => ({
  id,
  name: extra.name ?? `Name of ${id}`,
  ...(extra.deprecationDate && { deprecationDate: extra.deprecationDate }),
});

// Registers one fake provider per catalog provider, each serving every catalog model that lists it.
const buildDeps = (keys: KeyAnswers = {}, unregistered: readonly string[] = [], unlisted: readonly string[] = []) => {
  const served = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(IMAGE_MODEL_CATALOG)) {
    if (unregistered.includes(entry.provider) || unlisted.includes(id)) continue;
    served.set(entry.provider, [...(served.get(entry.provider) ?? []), id]);
  }
  const resolveApiKey = vi.fn(async (provider: ImageProviderId, _userId: string) =>
    keys[provider] === undefined ? 'key' : keys[provider]
  );
  const deps = {
    providers: { get: (provider: string) => (served.has(provider) ? { models: served.get(provider) } : undefined) },
    resolveApiKey,
  } as unknown as ImageModelAvailabilityDeps;
  return { deps, resolveApiKey };
};

const idsOf = async (offered: ReturnType<typeof offer>[], deps: ImageModelAvailabilityDeps) =>
  (await listUsableImageModels('user-1', offered, deps)).map(model => model.id);

describe('listUsableImageModels', () => {
  it('drops an id that is not in the catalog', async () => {
    const { deps } = buildDeps();
    expect(await idsOf([offer('not-a-model'), offer(ImageModels.FLUX_3_IMAGE)], deps)).toEqual([
      ImageModels.FLUX_3_IMAGE,
    ]);
  });

  it('drops a retired legacy id', async () => {
    const { deps } = buildDeps();
    expect(await idsOf([offer(ImageModels.GPT_IMAGE_1)], deps)).toEqual([]);
  });

  it('drops a model whose provider is not registered', async () => {
    const provider = IMAGE_MODEL_CATALOG[ImageModels.FLUX_3_IMAGE].provider;
    const { deps } = buildDeps({}, [provider]);
    expect(await idsOf([offer(ImageModels.FLUX_3_IMAGE)], deps)).toEqual([]);
  });

  it('drops a model its provider does not list', async () => {
    const { deps } = buildDeps({}, [], [ImageModels.FLUX_3_IMAGE]);
    expect(await idsOf([offer(ImageModels.FLUX_3_IMAGE)], deps)).toEqual([]);
  });

  it.each([null, ''])('drops a model whose provider key is unusable (%j)', async unusable => {
    const provider = IMAGE_MODEL_CATALOG[ImageModels.FLUX_3_IMAGE].provider;
    const { deps } = buildDeps({ [provider]: unusable });
    expect(await idsOf([offer(ImageModels.FLUX_3_IMAGE)], deps)).toEqual([]);
  });

  it('resolves the key once per provider', async () => {
    const { deps, resolveApiKey } = buildDeps();
    const sameProvider = Object.keys(IMAGE_MODEL_CATALOG).filter(
      id =>
        IMAGE_MODEL_CATALOG[id as ImageModels].provider === IMAGE_MODEL_CATALOG[ImageModels.GPT_IMAGE_1_5].provider &&
        id !== ImageModels.GPT_IMAGE_1
    );
    expect(sameProvider.length).toBeGreaterThan(1);
    await idsOf(
      sameProvider.map(id => offer(id)),
      deps
    );
    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(resolveApiKey).toHaveBeenCalledWith(IMAGE_MODEL_CATALOG[ImageModels.GPT_IMAGE_1_5].provider, 'user-1');
  });

  it('lists a duplicated offered id once', async () => {
    const { deps } = buildDeps();
    const ids = await idsOf([offer(ImageModels.FLUX_3_IMAGE), offer(ImageModels.FLUX_3_IMAGE)], deps);
    expect(ids).toEqual([ImageModels.FLUX_3_IMAGE]);
  });

  it('orders the result by rank rather than by offer order', async () => {
    const { deps } = buildDeps();
    const ids = await idsOf(
      [offer(ImageModels.GPT_IMAGE_1_5), offer(ImageModels.GEMINI_3_PRO_IMAGE), offer(ImageModels.FLUX_3_IMAGE)],
      deps
    );
    expect(ids).toEqual([ImageModels.FLUX_3_IMAGE, ImageModels.GEMINI_3_PRO_IMAGE, ImageModels.GPT_IMAGE_1_5]);
  });

  it('maps a model to its public shape', async () => {
    const { deps } = buildDeps();
    const id = ImageModels.GEMINI_3_PRO_IMAGE;
    const entry = IMAGE_MODEL_CATALOG[id];
    const [model] = await listUsableImageModels(
      'user-1',
      [offer(id, { name: 'Renamed', deprecationDate: '2027-01-01' })],
      deps
    );
    expect(model).toMatchObject({
      id,
      object: 'image_model',
      display_name: 'Renamed',
      provider_label: IMAGE_PROVIDER_LABELS[entry.provider],
      tier: entry.tier,
      released_at: entry.releasedAt,
      preview: entry.preview,
      deprecation_date: '2027-01-01',
    });
    expect(typeof model.credits_per_image).toBe('number');
  });

  it('reports a null deprecation date when the offer has none', async () => {
    const { deps } = buildDeps();
    const [model] = await listUsableImageModels('user-1', [offer(ImageModels.FLUX_3_IMAGE)], deps);
    expect(model.deprecation_date).toBeNull();
  });
});
