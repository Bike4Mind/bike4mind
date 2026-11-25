import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { PublicImageJob, VideoGeneration } from '@bike4mind/common';
import type { StudioJob } from '@shared/studio';
import type { MediaApiClient } from '../media/MediaApiClient';
import { LIBRARY_BUCKET, LibraryService, toLibraryItem, type LibraryDeps } from './LibraryService';

const imageJob = (id: string, output: Partial<NonNullable<PublicImageJob['output']>> | null = {}): PublicImageJob => ({
  id,
  object: 'image_generation',
  state: 'succeeded',
  model: 'img-model',
  mode: 'generate',
  prompt: `prompt ${id}`,
  group_id: null,
  source: 'studio',
  error: null,
  output:
    output === null
      ? null
      : {
          availability: 'ready',
          url: `https://cdn.example/${id}.png`,
          expires_at: '2099-01-01T00:00:00.000Z',
          content_type: 'image/png',
          file_id: null,
          ...output,
        },
  credits: { reserved: null, settled: 1 },
  created_at: '2026-01-02T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

const videoJob = (id: string): VideoGeneration =>
  ({
    id,
    object: 'video_generation',
    state: 'succeeded',
    model: 'vid-model',
    mode: 'text_to_video',
    prompt: 'a clip',
    duration_seconds: 4,
    aspect_ratio: '16:9',
    resolution: '720p',
    source: 'studio',
    progress: 1,
    error: null,
    output: {
      availability: 'ready',
      url: `https://cdn.example/${id}.mp4`,
      expires_at: null,
      content_type: 'video/mp4',
      duration_seconds: 4,
      file_id: null,
    },
    credits: { reserved: null, settled: 5 },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }) as VideoGeneration;

function setup(overrides: Partial<LibraryDeps> = {}) {
  const client = {
    listImageJobs: vi.fn(async () => ({
      data: [imageJob('a'), imageJob('b', null)],
      next_cursor: 'next' as string | null,
    })),
    listVideoGenerations: vi.fn(async () => ({ data: [videoJob('v')], next_cursor: null })),
    getImageJob: vi.fn(async (id: string) => imageJob(id)),
    getVideoGeneration: vi.fn(async (id: string) => videoJob(id)),
    fetchGenerated: vi.fn(async () => ({ bytes: Buffer.from('png'), contentType: 'application/octet-stream' })),
    openVideoDownload: vi.fn(async () => ({ stream: Readable.from([]), contentType: 'video/mp4' })),
  };
  let scope = 'account-1';
  const media = {
    save: vi.fn(async () => ({
      name: 'n.png',
      url: 'b4m-media://library-cache/n.png',
      mimeType: 'image/png',
      byteLength: 3,
    })),
    saveStream: vi.fn(async () => ({
      name: 'n.mp4',
      url: 'b4m-media://library-cache/n.mp4',
      mimeType: 'video/mp4',
      byteLength: 3,
    })),
    clearReusableBucket: vi.fn(async () => {}),
  };
  const deps: LibraryDeps = {
    connection: () => ({ scope, client: client as unknown as MediaApiClient }),
    media,
    sessions: async () => [],
    listJobs: async () => null,
    now: () => Date.parse('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
  const service = new LibraryService(deps);
  return { service, client, media, switchAccount: (next: string) => (scope = next) };
}

describe('toLibraryItem', () => {
  it('maps a video with its duration and drops a job with no output', () => {
    expect(toLibraryItem(videoJob('v'))).toMatchObject({ medium: 'video', durationSeconds: 4, aspectRatio: '16:9' });
    expect(toLibraryItem(imageJob('x', null))).toBeNull();
  });
});

describe('LibraryService', () => {
  it('lists finished jobs of the requested medium with the cursor passed through', async () => {
    const { service, client } = setup();
    const page = await service.page({ medium: 'image', cursor: 'c1' });
    expect(client.listImageJobs).toHaveBeenCalledWith({ limit: 24, cursor: 'c1' });
    expect(page).toEqual({
      items: [expect.objectContaining({ id: 'a', medium: 'image', prompt: 'prompt a', availability: 'ready' })],
      nextCursor: 'next',
    });
  });

  it('refuses when signed out', async () => {
    const { service } = setup({ connection: () => null });
    await expect(service.page({ medium: 'video' })).rejects.toThrow('Sign in');
  });

  it('downloads an image once, from the listed URL, typed by the job when the CDN is vague', async () => {
    const { service, client, media } = setup();
    await service.page({ medium: 'image' });
    const first = await service.media({ medium: 'image', id: 'a' });
    const again = await service.media({ medium: 'image', id: 'a' });
    expect(first).toEqual({ url: 'b4m-media://library-cache/n.png', mimeType: 'image/png' });
    expect(again).toBe(first);
    expect(client.getImageJob).not.toHaveBeenCalled();
    expect(client.fetchGenerated).toHaveBeenCalledExactlyOnceWith('https://cdn.example/a.png');
    expect(media.save).toHaveBeenCalledWith(LIBRARY_BUCKET, Buffer.from('png'), 'image/png');
  });

  it('re-reads the job for a URL it has not seen or that is about to expire', async () => {
    const { service, client } = setup();
    client.listImageJobs.mockResolvedValueOnce({
      data: [imageJob('old', { expires_at: '2026-06-01T00:00:10.000Z' })],
      next_cursor: null,
    });
    await service.page({ medium: 'image' });
    await service.media({ medium: 'image', id: 'old' });
    await service.media({ medium: 'image', id: 'unseen' });
    expect(client.getImageJob.mock.calls.map(call => call[0])).toEqual(['old', 'unseen']);
  });

  it('says why when the file is not downloadable, and retries on the next ask', async () => {
    const { service, client } = setup();
    client.getImageJob.mockResolvedValueOnce(
      imageJob('p', { availability: 'pending_scan', url: null, expires_at: null })
    );
    await expect(service.media({ medium: 'image', id: 'p' })).rejects.toThrow('still being checked');
    await expect(service.media({ medium: 'image', id: 'p' })).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('streams a video into the cache bucket', async () => {
    const { service, client, media } = setup();
    await service.page({ medium: 'video' });
    await expect(service.media({ medium: 'video', id: 'v' })).resolves.toMatchObject({ mimeType: 'video/mp4' });
    expect(client.openVideoDownload).toHaveBeenCalledWith('https://cdn.example/v.mp4', expect.anything());
    expect(media.saveStream).toHaveBeenCalledWith(LIBRARY_BUCKET, expect.anything(), 'video/mp4', expect.any(Number));
  });

  it('clears the cache on an account change', async () => {
    const { service, client, media, switchAccount } = setup();
    await service.page({ medium: 'image' });
    await service.media({ medium: 'image', id: 'a' });
    expect(media.clearReusableBucket).toHaveBeenCalledTimes(1); // at start
    switchAccount('account-2');
    await service.media({ medium: 'image', id: 'a' });
    expect(media.clearReusableBucket).toHaveBeenCalledTimes(2);
    expect(client.fetchGenerated).toHaveBeenCalledTimes(2);
    expect(client.getImageJob).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('still downloads when clearing the cache fails', async () => {
    const { media } = setup();
    media.clearReusableBucket.mockRejectedValue(new Error('EBUSY'));
    const { service, switchAccount } = setup({ media });
    await expect(service.media({ medium: 'image', id: 'a' })).resolves.toMatchObject({ mimeType: 'image/png' });
    switchAccount('account-2');
    await expect(service.media({ medium: 'image', id: 'a' })).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('finds the session a Studio Create saved an item into, studio sessions first', async () => {
    const job = { kind: 'image', providerJobIds: ['x', 'a'], originatingSessionId: 'studio-1' } as StudioJob;
    const listJobs = vi.fn(async (sessionId: string, cursor?: string) =>
      sessionId === 'studio-1' ? (cursor ? { items: [job] } : { items: [], nextCursor: 'p2' }) : { items: [] }
    );
    const { service } = setup({
      sessions: async () => [
        { id: 'chat-1', mode: 'chat' },
        { id: 'studio-1', mode: 'studio' },
      ],
      listJobs,
    });
    await expect(service.locate({ medium: 'image', id: 'a' })).resolves.toEqual({ sessionId: 'studio-1' });
    expect(listJobs.mock.calls[0][0]).toBe('studio-1');
    // Remembered: a second open reads nothing.
    listJobs.mockClear();
    await expect(service.locate({ medium: 'image', id: 'a' })).resolves.toEqual({ sessionId: 'studio-1' });
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('returns null for an item made outside desktop Studio', async () => {
    const { service } = setup({
      sessions: async () => [{ id: 's', mode: 'studio' }],
      listJobs: async () => ({ items: [] }),
    });
    await expect(service.locate({ medium: 'video', id: 'v' })).resolves.toBeNull();
  });
});
