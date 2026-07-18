import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { Logger } from '@bike4mind/observability';
import { LocalImageService } from './LocalImageService';

vi.mock('axios');
const mockedPost = vi.mocked(axios.post);
const mockedGet = vi.mocked(axios.get);

function makeService(baseUrl = 'http://imagegen:7860/') {
  return new LocalImageService(baseUrl, new Logger());
}

describe('LocalImageService.generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sd-models lookup finds nothing, so the bare checkpoint name is used.
    mockedGet.mockResolvedValue({ data: [] });
  });

  it('POSTs to /sdapi/v1/txt2img with the prefix stripped into override_settings and a trimmed base URL', async () => {
    mockedPost.mockResolvedValue({ data: { images: ['QUJD'] } });
    const svc = makeService('http://imagegen:7860/');

    await svc.generate('a red bike', {
      n: 2,
      model: 'local-image/v1-5-pruned-emaonly',
      width: 768,
      height: 512,
      steps: 25,
    });

    expect(mockedPost).toHaveBeenCalledTimes(1);
    const [url, body] = mockedPost.mock.calls[0];
    // Trailing slash trimmed so the path is not doubled.
    expect(url).toBe('http://imagegen:7860/sdapi/v1/txt2img');
    expect(body).toMatchObject({
      prompt: 'a red bike',
      steps: 25,
      width: 768,
      height: 512,
      batch_size: 2,
      override_settings: { sd_model_checkpoint: 'v1-5-pruned-emaonly' },
    });
  });

  it('uses the sd-models title (name [hash]) for the checkpoint override when the checkpoint is found', async () => {
    mockedGet.mockResolvedValue({
      data: [{ title: 'v1-5-pruned-emaonly.safetensors [abc123]', model_name: 'v1-5-pruned-emaonly' }],
    });
    mockedPost.mockResolvedValue({ data: { images: ['QUJD'] } });
    const svc = makeService();

    await svc.generate('a bike', { model: 'local-image/v1-5-pruned-emaonly' });

    const [, body] = mockedPost.mock.calls[0];
    expect(body).toMatchObject({
      override_settings: { sd_model_checkpoint: 'v1-5-pruned-emaonly.safetensors [abc123]' },
    });
  });

  it('falls back to the bare checkpoint name when the sd-models lookup fails', async () => {
    mockedGet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    mockedPost.mockResolvedValue({ data: { images: ['QUJD'] } });
    const svc = makeService();

    await svc.generate('a bike', { model: 'local-image/sd15' });

    const [, body] = mockedPost.mock.calls[0];
    expect(body).toMatchObject({ override_settings: { sd_model_checkpoint: 'sd15' } });
  });

  it('maps each bare base64 image to a data URI', async () => {
    mockedPost.mockResolvedValue({ data: { images: ['QUJD', 'REVG'] } });
    const svc = makeService();

    const result = await svc.generate('two cats', { model: 'local-image/sd15' });

    expect(result).toEqual(['data:image/png;base64,QUJD', 'data:image/png;base64,REVG']);
  });

  it('defaults steps to 20 and dimensions to 512x512, batch_size to 1', async () => {
    mockedPost.mockResolvedValue({ data: { images: ['QUJD'] } });
    const svc = makeService();

    await svc.generate('a prompt', { model: 'local-image/sd15' });

    const [, body] = mockedPost.mock.calls[0];
    expect(body).toMatchObject({ steps: 20, width: 512, height: 512, batch_size: 1 });
  });

  it('derives width/height from a size string when explicit dimensions are absent', async () => {
    mockedPost.mockResolvedValue({ data: { images: ['QUJD'] } });
    const svc = makeService();

    // size is passed via the shared options type (cast mirrors the tool call site).
    await svc.generate('a prompt', { model: 'local-image/sd15', size: '256x256' });

    const [, body] = mockedPost.mock.calls[0];
    expect(body).toMatchObject({ width: 256, height: 256 });
  });

  it('throws when the server returns no images', async () => {
    mockedPost.mockResolvedValue({ data: { images: [] } });
    const svc = makeService();

    await expect(svc.generate('nothing', { model: 'local-image/sd15' })).rejects.toThrow(/no images/i);
  });

  it('edit and variantions are not supported', async () => {
    const svc = makeService();
    await expect(svc.edit('img', 'prompt', {})).rejects.toThrow(/does not support/i);
    await expect(svc.variantions(Buffer.from(''), {})).rejects.toThrow(/does not support/i);
  });
});
