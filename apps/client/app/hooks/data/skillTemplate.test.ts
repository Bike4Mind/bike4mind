import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get } }));

import { waitForGeneratedImage } from './skillTemplate';

const quest = (data: Record<string, unknown>) => ({ data });

beforeEach(() => {
  h.get.mockReset();
});

describe('waitForGeneratedImage', () => {
  it('polls the quest until it has an image', async () => {
    h.get.mockResolvedValueOnce(quest({ images: [] })).mockResolvedValueOnce(quest({ images: ['a.png'] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).resolves.toBeUndefined();
    expect(h.get).toHaveBeenCalledTimes(2);
    expect(h.get).toHaveBeenCalledWith('/api/quests/q1');
  });

  it('fails when the generation errors', async () => {
    h.get.mockResolvedValue(quest({ images: [], type: 'error' }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).rejects.toThrow('The image generation failed');
  });

  it('keeps polling through a transient request failure', async () => {
    h.get.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(quest({ images: ['a.png'] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).resolves.toBeUndefined();
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('rethrows after three consecutive request failures', async () => {
    h.get.mockRejectedValue(new Error('network down'));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0 })).rejects.toThrow('network down');
    expect(h.get).toHaveBeenCalledTimes(3);
  });

  it('gives up after the poll budget', async () => {
    h.get.mockResolvedValue(quest({ images: [] }));
    await expect(waitForGeneratedImage('q1', { intervalMs: 0, maxPolls: 3 })).rejects.toThrow('taking too long');
    expect(h.get).toHaveBeenCalledTimes(3);
  });
});
