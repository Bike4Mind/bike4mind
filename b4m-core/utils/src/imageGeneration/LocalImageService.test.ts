import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { Logger } from '@bike4mind/observability';
import { LocalImageService } from './LocalImageService';

vi.mock('axios');
const mockedGet = vi.mocked(axios.get);
const mockedPost = vi.mocked(axios.post);

const BASE = 'http://imagegen:7860';

interface SdModel {
  title: string;
  model_name: string;
}
interface OptionsResp {
  sd_model_checkpoint?: string;
}

// Route GET/POST by URL so a single generate() call (sd-models + options poll +
// txt2img) can be stubbed coherently. `optionsSeq` lets GET /options return a
// sequence across polls (the last entry repeats).
function mockApi(cfg: {
  sdModels?: SdModel[];
  sdModelsError?: boolean;
  optionsSeq?: OptionsResp[];
  txt2img?: { images?: string[] };
}) {
  const optionsResponses = cfg.optionsSeq && cfg.optionsSeq.length > 0 ? [...cfg.optionsSeq] : [{}];
  const getImpl = (url: string) => {
    if (url.endsWith('/sdapi/v1/sd-models')) {
      if (cfg.sdModelsError) return Promise.reject(new Error('connect ECONNREFUSED'));
      return Promise.resolve({ data: cfg.sdModels ?? [] });
    }
    if (url.endsWith('/sdapi/v1/options')) {
      const next = optionsResponses.length > 1 ? optionsResponses.shift()! : optionsResponses[0];
      return Promise.resolve({ data: next });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  };
  const postImpl = (url: string) => {
    if (url.endsWith('/sdapi/v1/options')) return Promise.resolve({ data: {} });
    if (url.endsWith('/sdapi/v1/txt2img')) return Promise.resolve({ data: cfg.txt2img ?? { images: ['QUJD'] } });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  };
  mockedGet.mockImplementation(getImpl as unknown as typeof axios.get);
  mockedPost.mockImplementation(postImpl as unknown as typeof axios.post);
}

function makeService(baseUrl = BASE + '/') {
  // Tiny timings so the load poll doesn't sleep for real.
  return new LocalImageService(baseUrl, new Logger(), { modelLoadTimeoutMs: 200, modelLoadPollMs: 2 });
}

/** Body the txt2img POST was called with. */
function txt2imgBody() {
  const call = mockedPost.mock.calls.find(c => String(c[0]).endsWith('/sdapi/v1/txt2img'));
  return call?.[1] as Record<string, unknown> | undefined;
}
const optionsPosts = () => mockedPost.mock.calls.filter(c => String(c[0]).endsWith('/sdapi/v1/options'));

describe('LocalImageService.generate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('when the checkpoint is already loaded, goes straight to txt2img (no options POST)', async () => {
    mockApi({
      sdModels: [{ title: 'v1-5-pruned-emaonly.safetensors [abc]', model_name: 'v1-5-pruned-emaonly' }],
      optionsSeq: [{ sd_model_checkpoint: 'v1-5-pruned-emaonly.safetensors [abc]' }],
    });
    const svc = makeService('http://imagegen:7860/');

    await svc.generate('a red bike', {
      n: 2,
      model: 'local-image/v1-5-pruned-emaonly',
      width: 768,
      height: 512,
      steps: 25,
    });

    expect(optionsPosts()).toHaveLength(0);
    const txt2img = mockedPost.mock.calls.find(c => String(c[0]).endsWith('/sdapi/v1/txt2img'));
    // Trailing slash trimmed so the path is not doubled.
    expect(txt2img?.[0]).toBe('http://imagegen:7860/sdapi/v1/txt2img');
    expect(txt2imgBody()).toMatchObject({
      prompt: 'a red bike',
      steps: 25,
      width: 768,
      height: 512,
      batch_size: 2,
      // Title (name [hash]) preferred as the override value.
      override_settings: { sd_model_checkpoint: 'v1-5-pruned-emaonly.safetensors [abc]' },
    });
  });

  it('when a different (placeholder) model is loaded, POSTs options and polls until the target loads, then txt2img', async () => {
    mockApi({
      sdModels: [{ title: 'target.safetensors [t]', model_name: 'target' }],
      // initial check (mismatch) -> POST -> poll #1 (still loading) -> poll #2 (loaded)
      optionsSeq: [
        { sd_model_checkpoint: 'model.safetensors' },
        { sd_model_checkpoint: 'model.safetensors' },
        { sd_model_checkpoint: 'target.safetensors [t]' },
      ],
      txt2img: { images: ['QUJD'] },
    });
    const svc = makeService();

    const result = await svc.generate('a cat', { model: 'local-image/target' });

    expect(optionsPosts()).toHaveLength(1);
    expect(optionsPosts()[0][1]).toEqual({ sd_model_checkpoint: 'target.safetensors [t]' });
    expect(txt2imgBody()).toMatchObject({ override_settings: { sd_model_checkpoint: 'target.safetensors [t]' } });
    expect(result).toEqual(['data:image/png;base64,QUJD']);
  });

  it('does not treat a prefix-colliding checkpoint as already loaded (dreamshaper vs dreamshaper-xl)', async () => {
    mockApi({
      sdModels: [
        { title: 'dreamshaper.safetensors [aaa]', model_name: 'dreamshaper' },
        { title: 'dreamshaper-xl.safetensors [bbb]', model_name: 'dreamshaper-xl' },
      ],
      // dreamshaper-xl is loaded; a substring match on "dreamshaper" would wrongly
      // early-return and generate with the WRONG checkpoint. Exact-title matching
      // must instead trigger a real load, then see the target become loaded.
      optionsSeq: [
        { sd_model_checkpoint: 'dreamshaper-xl.safetensors [bbb]' },
        { sd_model_checkpoint: 'dreamshaper.safetensors [aaa]' },
      ],
    });
    const svc = makeService();

    await svc.generate('a portrait', { model: 'local-image/dreamshaper' });

    expect(optionsPosts()).toHaveLength(1);
    expect(optionsPosts()[0][1]).toEqual({ sd_model_checkpoint: 'dreamshaper.safetensors [aaa]' });
    expect(txt2imgBody()).toMatchObject({
      override_settings: { sd_model_checkpoint: 'dreamshaper.safetensors [aaa]' },
    });
  });

  it('clamps batch_size to the local ceiling when n exceeds it (n=10 -> 4)', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }] });
    const svc = makeService();

    await svc.generate('a crowd', { model: 'local-image/sd15', n: 10 });

    expect(txt2imgBody()).toMatchObject({ batch_size: 4 });
  });

  it('floors batch_size at 1 when n is zero or negative', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }] });
    const svc = makeService();

    await svc.generate('a bike', { model: 'local-image/sd15', n: 0 });

    expect(txt2imgBody()).toMatchObject({ batch_size: 1 });
  });

  it('throws a clear error when the model never finishes loading (poll timeout), without calling txt2img', async () => {
    mockApi({
      sdModels: [{ title: 'target.safetensors [t]', model_name: 'target' }],
      optionsSeq: [{ sd_model_checkpoint: 'model.safetensors' }], // always the placeholder -> never matches
    });
    const svc = makeService();

    await expect(svc.generate('a cat', { model: 'local-image/target' })).rejects.toThrow(/did not finish loading/i);
    expect(mockedPost.mock.calls.some(c => String(c[0]).endsWith('/sdapi/v1/txt2img'))).toBe(false);
  });

  it('strips the local-image/ prefix into override_settings when the checkpoint is not in sd-models', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'v1-5-pruned-emaonly' }] });
    const svc = makeService();

    await svc.generate('a bike', { model: 'local-image/v1-5-pruned-emaonly' });

    expect(txt2imgBody()).toMatchObject({ override_settings: { sd_model_checkpoint: 'v1-5-pruned-emaonly' } });
  });

  it('falls back to the bare checkpoint name when the sd-models lookup fails', async () => {
    mockApi({ sdModelsError: true, optionsSeq: [{ sd_model_checkpoint: 'sd15' }] });
    const svc = makeService();

    await svc.generate('a bike', { model: 'local-image/sd15' });

    expect(txt2imgBody()).toMatchObject({ override_settings: { sd_model_checkpoint: 'sd15' } });
  });

  it('maps each bare base64 image to a data URI', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }], txt2img: { images: ['QUJD', 'REVG'] } });
    const svc = makeService();

    const result = await svc.generate('two cats', { model: 'local-image/sd15' });

    expect(result).toEqual(['data:image/png;base64,QUJD', 'data:image/png;base64,REVG']);
  });

  it('defaults steps to 20 and dimensions to 512x512, batch_size to 1', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }] });
    const svc = makeService();

    await svc.generate('a prompt', { model: 'local-image/sd15' });

    expect(txt2imgBody()).toMatchObject({ steps: 20, width: 512, height: 512, batch_size: 1 });
  });

  it('derives width/height from a size string when explicit dimensions are absent', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }] });
    const svc = makeService();

    await svc.generate('a prompt', { model: 'local-image/sd15', size: '256x256' });

    expect(txt2imgBody()).toMatchObject({ width: 256, height: 256 });
  });

  it('throws when the server returns no images (200 with empty list)', async () => {
    mockApi({ sdModels: [], optionsSeq: [{ sd_model_checkpoint: 'sd15' }], txt2img: { images: [] } });
    const svc = makeService();

    await expect(svc.generate('nothing', { model: 'local-image/sd15' })).rejects.toThrow(/no images/i);
  });

  it('edit and variantions are not supported', async () => {
    const svc = makeService();
    await expect(svc.edit('img', 'prompt', {})).rejects.toThrow(/does not support/i);
    await expect(svc.variantions(Buffer.from(''), {})).rejects.toThrow(/does not support/i);
  });
});
