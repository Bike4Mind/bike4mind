import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaApiClient } from '../../media/MediaApiClient';
import { MediaStore } from '../../media/MediaStore';
import { SessionStore } from '../../SessionStore';
import { sessionScopeKey, type SessionScope } from '../../sessionScope';
import { StudioWorkspaceStore } from '../StudioWorkspaceStore';
import {
  StudioGenerationService,
  type StudioGenerationDeps,
  type StudioGenerationRequest,
} from './StudioGenerationService';

const account = { environmentUrl: 'https://example.com', accountId: 'one' };
const image: StudioGenerationRequest = { kind: 'image', body: { prompt: 'a bicycle', model: 'gpt-image-2' } };
const music: StudioGenerationRequest = { kind: 'music', body: { prompt: 'calm music', model: 'lyria-3.5' } };

describe('Studio generation', () => {
  let root: string;
  let scope: SessionScope | null;
  let sessions: SessionStore;
  let workspaces: StudioWorkspaceStore;
  let media: MediaStore;
  let deps: StudioGenerationDeps;
  let service: StudioGenerationService;
  const client = {
    createStudioImages: vi.fn(),
    listStudioImages: vi.fn(),
    getFile: vi.fn(),
    generateImage: vi.fn(),
    getQuest: vi.fn(),
    fetchGenerated: vi.fn(),
    createMusicGeneration: vi.fn(),
    getMusicGeneration: vi.fn(),
    cancelMusicGeneration: vi.fn(),
    createVideoGeneration: vi.fn(),
    getVideoGeneration: vi.fn(),
    cancelVideoGeneration: vi.fn(),
    synthesizeSpeech: vi.fn(),
    generateSoundEffect: vi.fn(),
    openVideoDownload: vi.fn(),
  };
  const authorize = vi.fn(async () => true);

  beforeEach(async () => {
    vi.resetAllMocks();
    authorize.mockResolvedValue(true);
    root = await mkdtemp(join(tmpdir(), 'studio-generation-'));
    scope = account;
    sessions = new SessionStore(join(root, 'sessions'), 'model', 'launch', () => scope);
    workspaces = new StudioWorkspaceStore(join(root, 'studio'), sessions);
    media = new MediaStore(join(root, 'media'));
    deps = {
      workspaces,
      media,
      authorize,
      connection: () =>
        scope
          ? {
              scope: sessionScopeKey(scope),
              client: client as unknown as MediaApiClient,
              cdnUrl: 'https://cdn.example',
            }
          : null,
    };
    service = new StudioGenerationService(deps);
    client.generateImage.mockResolvedValue({ questId: 'quest' });
    client.getQuest.mockResolvedValue({
      id: 'quest',
      status: 'done',
      files: [{ name: 'image.png', url: '/image.png', isImage: true }],
    });
    client.fetchGenerated.mockResolvedValue({ bytes: Buffer.from('image'), contentType: 'image/png' });
    client.createMusicGeneration.mockResolvedValue({ id: 'song' });
    client.getMusicGeneration.mockResolvedValue({
      state: 'succeeded',
      output: { availability: 'ready', url: '/song', content_type: 'audio/mpeg' },
    });
    client.createVideoGeneration.mockResolvedValue({ id: 'clip' });
    client.getVideoGeneration.mockResolvedValue({
      state: 'succeeded',
      output: { availability: 'ready', url: '/clip', content_type: 'video/mp4' },
    });
    client.openVideoDownload.mockImplementation(async () => ({
      stream: Readable.from([Buffer.from('clip')]),
      contentType: 'video/mp4',
    }));
    client.synthesizeSpeech.mockResolvedValue({
      delivery: 'inline',
      audio: Buffer.from('speech').toString('base64'),
      contentType: 'audio/mpeg',
    });
    client.generateSoundEffect.mockResolvedValue({ audio: Buffer.from('sound'), contentType: 'audio/mpeg' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('validates before approval and refuses spending without approval', async () => {
    const session = await sessions.create();
    await expect(service.submit(session.id, { kind: 'music', body: { model: '', prompt: '' } })).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
    authorize.mockResolvedValue(false);
    await expect(service.submit(session.id, image)).rejects.toThrow('not approved');
    expect(client.generateImage).not.toHaveBeenCalled();
    expect((await workspaces.get(session.id))?.jobs).toEqual([]);
  });
  it('submits one image batch, durably recovers child IDs, and keeps partial successes beside failures', async () => {
    const session = await sessions.create();
    client.createStudioImages.mockResolvedValue({ groupId: 'group', jobs: [{ id: 'one' }, { id: 'two' }] });
    client.listStudioImages.mockResolvedValue({
      data: [
        { id: 'one', state: 'succeeded', output: { fileId: 'file-one' }, error: null },
        { id: 'two', state: 'failed', output: null, error: { message: 'Image two failed' } },
      ],
      next_cursor: null,
    });
    client.getFile.mockResolvedValue({ moderation_status: 'clean', download_url: '/output', mime_type: 'image/png' });
    const job = await service.submit(session.id, {
      kind: 'image',
      count: 2,
      body: { model: 'gpt-image-2', mode: 'generate', prompt: 'Two images', size: '1024x1024' },
    });
    expect(client.createStudioImages).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-image-2', size: '1024x1024' }),
      2,
      expect.any(String)
    );
    expect((await workspaces.getJob(session.id, job.id))?.providerJobIds).toEqual(['one', 'two']);
    service = new StudioGenerationService(deps);
    await service.recover(session.id);
    const recovered = await workspaces.getJob(session.id, job.id);
    expect(recovered).toEqual(
      expect.objectContaining({ state: 'completed', assetIds: [`${job.id}_0`], outputErrors: ['Image two failed'] })
    );
    expect((await workspaces.getAsset(session.id, `${job.id}_0`))?.creation?.settings.count).toBe(2);
    await service.recover(session.id);
    expect(client.createStudioImages).toHaveBeenCalledTimes(1);
    expect(client.generateImage).not.toHaveBeenCalled();
  });

  it('copies chat media into family storage and never reimports deleted assets', async () => {
    const parent = await sessions.create();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '' },
    });
    const stored = await media.save(parent.id, Buffer.from('chat image'), 'image/png');
    const asset = {
      id: 'chat-image',
      kind: 'image' as const,
      title: 'Chat image',
      originatingSessionId: parent.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: stored.url,
    };
    await service.importChatAsset(parent.id, asset);
    await media.forgetSession(parent.id);
    const file = await service.locateAsset(child.id, asset.id);
    expect(file && (await readFile(file.path, 'utf8'))).toBe('chat image');
    await service.removeAsset(child.id, asset.id);
    await service.importChatAsset(child.id, asset);
    expect(await workspaces.getAsset(child.id, asset.id)).toBeNull();
    expect(client.generateImage).not.toHaveBeenCalled();
  });

  const requests: StudioGenerationRequest[] = [
    image,
    music,
    { kind: 'video', body: { prompt: 'a bicycle', model: 'gemini-omni-1.1-flash' } },
    { kind: 'speech', body: { text: 'hello' } },
    { kind: 'sound-effect', body: { text: 'a bicycle bell' } },
  ];
  it('persists validated settings on outputs for reuse without another paid request', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, image);
    await service.reconcile(session.id, job.id);
    const asset = await workspaces.getAsset(session.id, `${job.id}_0`);
    expect(asset?.creation).toEqual(
      expect.objectContaining({ prompt: 'a bicycle', settings: expect.objectContaining({ model: 'gpt-image-2' }) })
    );
    expect(client.generateImage).toHaveBeenCalledTimes(1);
  });
  it('imports a completed chat video into workspace storage without another provider call', async () => {
    const session = await sessions.create();
    const stored = await media.saveStream(session.id, Readable.from([Buffer.from('local video')]), 'video/mp4', 1024);
    await service.importChatAsset(session.id, {
      id: 'chat-video',
      kind: 'video',
      title: 'Clip',
      originatingSessionId: session.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: stored.url,
    });
    const file = await service.locateAsset(session.id, 'chat-video');
    expect(file && (await readFile(file.path, 'utf8'))).toBe('local video');
    expect(client.createVideoGeneration).not.toHaveBeenCalled();
  });
  it('ends automatic polling after seven days without claiming cancellation or deleting the job', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, image);
    await workspaces.upsertJob(session.id, {
      ...job,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    });
    await service.recover(session.id);
    const expired = await workspaces.getJob(session.id, job.id);
    expect(expired).toEqual(
      expect.objectContaining({ state: 'unknown', recoveryExpired: true, providerJobId: 'quest' })
    );
    expect(client.getQuest).not.toHaveBeenCalled();
    await service.reconcile(session.id, job.id);
    expect(client.getQuest).toHaveBeenCalledTimes(1);
    expect(client.generateImage).toHaveBeenCalledTimes(1);
  });
  it.each(requests)('adapts $kind with durable output and no repeated spend during recovery', async request => {
    const session = await sessions.create();
    const submitted = await service.submit(session.id, request);
    if (request.kind === 'image') {
      expect(client.generateImage).toHaveBeenCalledWith({ ...request.body, prompt_resolution: 'literal' });
    }
    const restarted = new StudioGenerationService(deps);
    const [job] = await restarted.recover(session.id);
    expect(job).toMatchObject({ id: submitted.id, state: 'completed' });
    expect(authorize).toHaveBeenCalledTimes(1);
    const workspace = await workspaces.get(session.id);
    expect(workspace?.assets).toHaveLength(1);
    const asset = workspace!.assets[0];
    expect(asset).toMatchObject({ jobId: submitted.id, kind: request.kind });
    const file = await restarted.locateAsset(session.id, asset.id);
    expect(file?.size).toBeGreaterThan(0);
    await restarted.recover(session.id);
    expect((await workspaces.get(session.id))?.assets).toHaveLength(1);
    expect(
      client.generateImage.mock.calls.length +
        client.createMusicGeneration.mock.calls.length +
        client.createVideoGeneration.mock.calls.length +
        client.synthesizeSpeech.mock.calls.length +
        client.generateSoundEffect.mock.calls.length
    ).toBe(1);
  });

  it('persists submitting before the network call and quarantines ambiguous submissions', async () => {
    const session = await sessions.create();
    client.generateImage.mockImplementation(async () => {
      expect((await workspaces.get(session.id))?.jobs[0].state).toBe('submitting');
      throw new Error('transport timeout');
    });
    const job = await service.submit(session.id, image);
    expect(job.state).toBe('unknown');
    await new StudioGenerationService(deps).recover(session.id);
    expect(client.generateImage).toHaveBeenCalledTimes(1);
    expect(client.getQuest).not.toHaveBeenCalled();
  });

  it('retains provider IDs on interrupted downloads and serializes concurrent reconciliation', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, music);
    expect(client.createMusicGeneration).toHaveBeenCalledWith(music.body, job.idempotencyKey);
    client.fetchGenerated.mockRejectedValueOnce(new Error('offline'));
    await expect(service.reconcile(session.id, job.id)).rejects.toThrow('offline');
    expect((await workspaces.get(session.id))?.jobs[0].providerJobId).toBe('song');
    await Promise.all([service.reconcile(session.id, job.id), service.reconcile(session.id, job.id)]);
    expect((await workspaces.get(session.id))?.assets).toHaveLength(1);
    expect(client.fetchGenerated).toHaveBeenCalledTimes(2);
  });

  it('keeps pending jobs and local bytes after deleting the originating family member', async () => {
    const parent = await sessions.create();
    const child = await sessions.create(undefined, {
      origin: { parentSessionId: parent.id, depth: 1, seedPrompt: '' },
    });
    const job = await service.submit(parent.id, image);
    await sessions.delete(parent.id);
    await media.forgetSession(parent.id);
    await service.reconcile(child.id, job.id);
    const asset = (await workspaces.get(child.id))!.assets[0];
    await service.renameAsset(child.id, asset.id, 'Renamed');
    expect((await workspaces.get(child.id))?.assets[0].title).toBe('Renamed');
    const file = await service.locateAsset(child.id, asset.id);
    expect((await readFile(file!.path)).toString()).toBe('image');
    await service.removeAsset(child.id, asset.id);
    expect(await service.locateAsset(child.id, asset.id)).toBeNull();
    expect((await workspaces.get(child.id))?.assets).toEqual([]);
    await service.recover(child.id);
    expect((await workspaces.get(child.id))?.assets).toEqual([]);
  });

  it('isolates unrelated families, paths and signed-out accounts', async () => {
    const first = await sessions.create();
    const other = await sessions.create();
    const job = await service.submit(first.id, image);
    await expect(service.reconcile(other.id, job.id)).rejects.toThrow('not found');
    await expect(service.locateAsset('../escape', '../asset')).rejects.toThrow();
    scope = { ...account, accountId: 'two' };
    await expect(service.reconcile(first.id, job.id)).rejects.toThrow();
    expect(client.getQuest).not.toHaveBeenCalled();
    scope = null;
    await expect(service.recover(first.id)).rejects.toThrow('Sign in');
  });

  it('refuses an account switch during approval without spending', async () => {
    const session = await sessions.create();
    authorize.mockImplementationOnce(async () => {
      scope = null;
      return true;
    });
    await expect(service.submit(session.id, image)).rejects.toThrow('account changed');
    expect(client.generateImage).not.toHaveBeenCalled();
  });

  it('rejects out-of-workspace asset URLs', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, { kind: 'sound-effect', body: { text: 'bell' } });
    const asset = (await workspaces.get(session.id))!.assets[0];
    await workspaces.upsertAsset(session.id, {
      ...asset,
      url: `b4m-media://media/${session.id}/00000000-0000-4000-8000-000000000000.mp3`,
    });
    await expect(service.locateAsset(session.id, job.assetIds[0])).rejects.toThrow('Invalid Studio asset');
  });

  it('only claims cancellation when the backend confirms it', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, music);
    client.cancelMusicGeneration
      .mockResolvedValueOnce({ state: 'running' })
      .mockResolvedValueOnce({ state: 'cancelled' });
    expect((await service.cancel(session.id, job.id)).state).toBe('queued');
    expect((await service.cancel(session.id, job.id)).state).toBe('cancelled');
    const imageJob = await service.submit(session.id, image);
    await expect(service.cancel(session.id, imageJob.id)).rejects.toThrow('cannot cancel');
  });

  it('recovers inline output committed before the final job update without spending', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, { kind: 'speech', body: { text: 'hello' } });
    await workspaces.upsertJob(session.id, { ...job, state: 'submitting', assetIds: [] });
    const recovered = await new StudioGenerationService(deps).reconcile(session.id, job.id);
    expect(recovered).toMatchObject({ state: 'completed', assetIds: job.assetIds });
    expect(client.synthesizeSpeech).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect an asset when rename is concurrent with deletion', async () => {
    const session = await sessions.create();
    const job = await service.submit(session.id, { kind: 'speech', body: { text: 'hello' } });
    const results = await Promise.allSettled([
      service.removeAsset(session.id, job.assetIds[0]),
      service.renameAsset(session.id, job.assetIds[0], 'late rename'),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect((await workspaces.get(session.id))?.assets).toEqual([]);
  });

  it('does not individually read completed jobs during recovery', async () => {
    const session = await sessions.create();
    await service.submit(session.id, { kind: 'speech', body: { text: 'hello' } });
    const lookup = vi.spyOn(workspaces, 'getJob');
    await service.recover(session.id);
    expect(lookup).not.toHaveBeenCalled();
  });
});
