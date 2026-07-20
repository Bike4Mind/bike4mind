import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { ModelBackend } from '@bike4mind/common';
import { LocalImageBackend } from './localImageBackend';

vi.mock('axios');
const mockedGet = vi.mocked(axios.get);

function makeBackend(baseUrl = 'http://imagegen:7860/') {
  return new LocalImageBackend(baseUrl);
}

describe('LocalImageBackend.getModelInfo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps each installed checkpoint to a namespaced, free image ModelInfo', async () => {
    mockedGet.mockResolvedValue({
      data: [
        { title: 'v1-5-pruned-emaonly.safetensors [abc]', model_name: 'v1-5-pruned-emaonly' },
        { title: 'sd_xl_base.safetensors [def]', model_name: 'sd_xl_base' },
      ],
    });

    const models = await makeBackend('http://imagegen:7860/').getModelInfo();

    // Trailing slash trimmed - path not doubled.
    expect(mockedGet.mock.calls[0][0]).toBe('http://imagegen:7860/sdapi/v1/sd-models');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'local-image/v1-5-pruned-emaonly',
      name: 'v1-5-pruned-emaonly',
      type: 'image',
      backend: ModelBackend.LocalImage,
      supportsImageVariation: false,
      freeToRun: true,
      pricing: { 1: { input: 0, output: 0 } },
    });
    expect(models[1].id).toBe('local-image/sd_xl_base');
  });

  it('returns an empty list on a connection error (server down)', async () => {
    mockedGet.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const models = await makeBackend().getModelInfo();

    expect(models).toEqual([]);
  });

  it('does not support text completion', async () => {
    await expect(makeBackend().complete('local-image/sd15', [], {}, async () => {})).rejects.toThrow(
      /does not support text completion/i
    );
  });
});
