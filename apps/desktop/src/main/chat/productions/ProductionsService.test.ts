import { Readable } from 'node:stream';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { MediaApiClient } from '../media/MediaApiClient';
import { NOT_ENABLED_MESSAGE, ProductionsClient, toProductionsError } from './ProductionsClient';
import { PRODUCTIONS_BUCKET, PRODUCTIONS_PAGE_SIZE, ProductionsService } from './ProductionsService';

const ID = 'c'.repeat(24);
const FILE = 'f'.repeat(24);
const NOW = '2026-11-20T10:00:00.000Z';

function axiosError(status: number, data: unknown): AxiosError {
  const headers = new AxiosHeaders();
  return new AxiosError('Request failed', 'ERR', undefined, undefined, {
    status,
    statusText: '',
    headers,
    config: { headers },
    data,
  });
}

function composition(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title: 'Launch',
    template: 'ad_campaign',
    brief: {},
    brandKit: { colors: [], productFileIds: [] },
    shots: [{ id: 's1', title: 'Hero shot', fileIds: [FILE], chosenFileId: FILE }],
    timeline: {
      version: 1,
      durationMs: 15_000,
      fps: 30,
      backgroundColor: '#000000',
      outputs: [{ id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 }],
      tracks: [
        {
          id: 'v1',
          kind: 'video',
          enabled: true,
          clips: [
            { id: 'b', startMs: 4_000, durationMs: 2_000, fileId: 'e'.repeat(24) },
            { id: 'a', startMs: 0, durationMs: 4_000, fileId: FILE },
          ],
        },
        { id: 'cap', kind: 'captions', enabled: true, clips: [{ id: 'k', startMs: 0, durationMs: 1_000, text: 'Hi' }] },
      ],
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function renderJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'j1',
    groupId: 'g1',
    compositionId: ID,
    state: 'running',
    progress: 0.4,
    output: { id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 },
    heldCredits: 10,
    settledCredits: null,
    error: null,
    file: null,
    createdAt: NOW,
    ...overrides,
  };
}

function setup(options: { connected?: boolean } = {}) {
  const account = { scope: 'acct' };
  const patch = vi.fn(async (_url: string, body: unknown) => ({
    data: { composition: composition(body as Record<string, unknown>) },
  }));
  const api = {
    get: vi.fn(async (url: string): Promise<unknown> => {
      if (url.endsWith('/renders')) return { data: [renderJob()] };
      if (url.endsWith(ID)) return { composition: composition() };
      return { data: [composition()] };
    }),
    post: vi.fn(async () => ({
      groupId: 'g2',
      jobs: [renderJob({ id: 'j2', groupId: 'g2', state: 'pending', progress: null })],
    })),
    getAxiosInstance: () => ({ patch }),
  };
  const files = {
    getFile: vi.fn(async (): Promise<{ download_url: string | null } & Record<string, unknown>> => ({
      id: FILE,
      file_name: 'out.mp4',
      mime_type: 'video/mp4',
      file_size: 10,
      moderation_status: 'clean',
      download_url: 'https://cdn.example.test/out.mp4',
      download_url_expires_at: NOW,
      created_at: NOW,
    })),
    openVideoDownload: vi.fn(async () => ({ stream: Readable.from([]), contentType: 'video/mp4' })),
  };
  const media = {
    saveStream: vi.fn(async () => ({ url: 'b4m-media://productions-cache/x.mp4', mimeType: 'video/mp4' })),
    clearReusableBucket: vi.fn(async () => {}),
  };
  const service = new ProductionsService({
    connection: () =>
      options.connected === false
        ? null
        : {
            scope: account.scope,
            productions: new ProductionsClient(api as unknown as AuthenticatedApiClient),
            files: files as unknown as MediaApiClient,
          },
    media: media as never,
  });
  return { service, api, patch, files, media, account };
}

describe('toProductionsError', () => {
  it('reads the rollout gate as not-enabled on any route', () => {
    const error = toProductionsError(
      axiosError(403, { error: 'Feature not available', code: 'FEATURE_DISABLED' }),
      'x',
      'item'
    );
    expect(error).toMatchObject({ kind: 'not-enabled', message: NOT_ENABLED_MESSAGE });
  });

  it('reads a 404 on the list route as not-enabled and on an item as not-found', () => {
    expect(toProductionsError(axiosError(404, {}), 'x', 'list').kind).toBe('not-enabled');
    expect(toProductionsError(axiosError(404, { error: 'not_found' }), 'x', 'item').kind).toBe('not-found');
  });

  it('keeps any other 403 a failure with the server message (the paid-plan export refusal)', () => {
    const error = toProductionsError(
      axiosError(403, { error: 'Video export needs a paid plan' }),
      'Starting the export',
      'item'
    );
    expect(error).toMatchObject({
      kind: 'failed',
      message: 'Starting the export failed: Video export needs a paid plan',
    });
  });

  it('reads a 401 as signed-out, a bare 5xx by status, and a plain error by its message', () => {
    expect(toProductionsError(axiosError(401, {}), 'x', 'item').kind).toBe('signed-out');
    expect(toProductionsError(axiosError(503, null), 'Loading', 'item').message).toBe('Loading failed with HTTP 503.');
    expect(toProductionsError(new Error('boom'), 'Loading', 'item').message).toBe('Loading failed: boom');
  });

  it('prefers a refusal message over its code', () => {
    const error = toProductionsError(
      axiosError(422, { error: 'empty_timeline', message: 'Add a clip first.' }),
      'Export',
      'item'
    );
    expect(error.message).toBe('Export failed: Add a clip first.');
  });
});

describe('ProductionsService', () => {
  it('lists summaries and pages by skip until a short page', async () => {
    const { service, api } = setup();
    const result = await service.list({});
    expect(api.get).toHaveBeenCalledWith(
      '/api/studio/compositions',
      expect.objectContaining({ params: { limit: PRODUCTIONS_PAGE_SIZE, skip: 0 } })
    );
    expect(result).toEqual({
      ok: true,
      value: { items: [{ id: ID, title: 'Launch', template: 'ad_campaign', updatedAt: NOW }], nextSkip: null },
    });
  });

  it('answers signed-out without a connection', async () => {
    const { service } = setup({ connected: false });
    expect(await service.list({})).toMatchObject({ ok: false, error: { kind: 'signed-out' } });
  });

  it('surfaces the rollout gate as a result, not a throw', async () => {
    const { service, api } = setup();
    api.get.mockRejectedValueOnce(axiosError(403, { code: 'FEATURE_DISABLED' }));
    expect(await service.list({})).toMatchObject({ ok: false, error: { kind: 'not-enabled' } });
  });

  it('rejects a reply that does not match the shared schema', async () => {
    const { service, api } = setup();
    api.get.mockResolvedValueOnce({ data: [{ id: ID }] });
    expect(await service.list({})).toMatchObject({
      ok: false,
      error: { kind: 'failed', message: expect.stringContaining('unexpected reply') },
    });
  });

  it('opens a production with video clips sorted by start and labelled by their shot', async () => {
    const { service } = setup();
    const result = await service.get({ id: ID });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.videoTracks[0].clips.map(clip => [clip.id, clip.label])).toEqual([
      ['a', 'Hero shot'],
      ['b', 'Clip 2'],
    ]);
    expect(result.value.otherClipCount).toBe(1);
    expect(result.value.outputs).toEqual([{ id: 'o1', aspectRatio: '16:9', width: 1920, height: 1080 }]);
  });

  it('keeps a fallback clip label with its clip when the order changes', async () => {
    const { service, api } = setup();
    const swapped = composition();
    const track = swapped.timeline.tracks[0] as { clips: Array<{ id: string; startMs: number }> };
    track.clips[0].startMs = 0;
    track.clips[1].startMs = 4_000;
    api.get.mockResolvedValueOnce({ composition: swapped });
    const result = await service.get({ id: ID });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.videoTracks[0].clips.map(clip => [clip.id, clip.label])).toEqual([
      ['b', 'Clip 2'],
      ['a', 'Hero shot'],
    ]);
  });

  it('renames with a title-only PATCH', async () => {
    const { service, patch } = setup();
    const result = await service.rename({ id: ID, title: 'Spring launch' });
    expect(patch).toHaveBeenCalledWith(`/api/studio/compositions/${ID}`, { title: 'Spring launch' }, expect.anything());
    expect(result).toMatchObject({ ok: true, value: { title: 'Spring launch' } });
  });

  it('reorders from a fresh read and PATCHes only the timeline', async () => {
    const { service, api, patch } = setup();
    const result = await service.reorder({ id: ID, trackId: 'v1', clipIds: ['b', 'a'] });
    expect(api.get).toHaveBeenCalledWith(`/api/studio/compositions/${ID}`, expect.anything());
    const body = patch.mock.calls[0][1] as { timeline: { tracks: { clips: { id: string; startMs: number }[] }[] } };
    expect(Object.keys(body)).toEqual(['timeline']);
    expect(body.timeline.tracks[0].clips.map(clip => [clip.id, clip.startMs])).toEqual([
      ['b', 0],
      ['a', 2_000],
    ]);
    expect(result.ok).toBe(true);
  });

  it('refuses a reorder against a changed timeline without saving', async () => {
    const { service, patch } = setup();
    const result = await service.reorder({ id: ID, trackId: 'v1', clipIds: ['a'] });
    expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(patch).not.toHaveBeenCalled();
  });

  it('starts a render with only the output ids and maps the jobs', async () => {
    const { service, api } = setup();
    const result = await service.render({ id: ID, outputIds: ['o1'] });
    expect(api.post).toHaveBeenCalledWith(
      `/api/studio/compositions/${ID}/renders`,
      { outputIds: ['o1'] },
      expect.anything()
    );
    expect(result).toMatchObject({ ok: true, value: [{ id: 'j2', state: 'pending', fileId: null }] });
  });

  it('downloads a finished render once into its bucket', async () => {
    const { service, files, media } = setup();
    const first = await service.media({ fileId: FILE });
    const second = await service.media({ fileId: FILE });
    expect(first).toEqual({ ok: true, value: { url: 'b4m-media://productions-cache/x.mp4', mimeType: 'video/mp4' } });
    expect(second).toEqual(first);
    expect(files.getFile).toHaveBeenCalledTimes(1);
    expect(media.saveStream).toHaveBeenCalledWith(
      PRODUCTIONS_BUCKET,
      expect.anything(),
      'video/mp4',
      expect.any(Number)
    );
  });

  it('drops its downloads and the bucket when the account changes', async () => {
    const { service, files, media, account } = setup();
    await service.media({ fileId: FILE });
    media.clearReusableBucket.mockClear();
    account.scope = 'other';
    await service.media({ fileId: FILE });
    expect(files.getFile).toHaveBeenCalledTimes(2);
    expect(media.clearReusableBucket).toHaveBeenCalledWith(PRODUCTIONS_BUCKET);
  });

  it('answers not-ready while the file has no URL, and retries on the next ask', async () => {
    const { service, files } = setup();
    files.getFile.mockResolvedValueOnce({ ...(await files.getFile()), download_url: null });
    files.getFile.mockClear();
    expect(await service.media({ fileId: FILE })).toMatchObject({ ok: false, error: { kind: 'not-ready' } });
    expect(await service.media({ fileId: FILE })).toMatchObject({ ok: true });
  });
});
