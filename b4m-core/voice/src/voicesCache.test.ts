import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearElevenLabsVoicesCache, fetchElevenLabsVoices } from './voicesCache';

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  clearElevenLabsVoicesCache();
});

describe('fetchElevenLabsVoices', () => {
  it('maps voice_id / preview_url to camelCase and preserves labels', async () => {
    const fetchImpl = mockFetch({
      voices: [
        {
          voice_id: 'v1',
          name: 'Alice',
          labels: { accent: 'british', gender: 'female' },
          preview_url: 'https://eleven.example/v1.mp3',
        },
        { voice_id: 'v2', name: 'Bob' },
      ],
    });

    const voices = await fetchElevenLabsVoices('key', { fetchImpl });

    expect(voices).toEqual([
      {
        id: 'v1',
        name: 'Alice',
        labels: { accent: 'british', gender: 'female' },
        previewUrl: 'https://eleven.example/v1.mp3',
      },
      { id: 'v2', name: 'Bob', labels: {} },
    ]);
  });

  it('serves the second call from cache without re-fetching', async () => {
    const fetchImpl = mockFetch({ voices: [{ voice_id: 'v1', name: 'Alice' }] });

    await fetchElevenLabsVoices('key', { fetchImpl });
    await fetchElevenLabsVoices('key', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('separates cache entries by API key', async () => {
    const fetchImpl = mockFetch({ voices: [{ voice_id: 'v1', name: 'Alice' }] });

    await fetchElevenLabsVoices('key-a', { fetchImpl });
    await fetchElevenLabsVoices('key-b', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refetches when force=true', async () => {
    const fetchImpl = mockFetch({ voices: [{ voice_id: 'v1', name: 'Alice' }] });

    await fetchElevenLabsVoices('key', { fetchImpl });
    await fetchElevenLabsVoices('key', { fetchImpl, force: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when API key is missing', async () => {
    await expect(fetchElevenLabsVoices('')).rejects.toThrow(/API key/);
  });

  it('throws on non-OK response with status + body', async () => {
    const fetchImpl = mockFetch({ detail: 'forbidden' }, false, 403);
    await expect(fetchElevenLabsVoices('key', { fetchImpl })).rejects.toThrow(/403/);
  });
});
