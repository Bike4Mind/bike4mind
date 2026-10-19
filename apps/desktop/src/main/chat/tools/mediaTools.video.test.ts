import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoGeneration, VideoModel } from '@bike4mind/common';
import type { ChatToolNotice } from '@shared/chat';
import { describe, expect, it, vi } from 'vitest';
import { publicVideoModel } from '../media/__fixtures__/videoModels';
import type { MediaApiClient } from '../media/MediaApiClient';
import { MediaStore } from '../media/MediaStore';
import { generateVideoTool } from './mediaTools';
import type { MediaContext, ToolContext } from './types';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';
const gemini = publicVideoModel('gemini-omni-1.1-flash');
const veo = publicVideoModel('veo-3.1-fast-generate-preview');

const created: VideoGeneration = {
  id: 'job-1',
  object: 'video_generation',
  state: 'pending',
  model: gemini.id,
  mode: 'text_to_video',
  prompt: 'a red lighthouse',
  duration_seconds: 6,
  aspect_ratio: '16:9',
  resolution: '720p',
  source: 'studio',
  progress: null,
  error: null,
  output: null,
  credits: { reserved: 1217, settled: null },
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
};

async function harness(options: { models?: VideoModel[]; roots?: string[]; protectedPaths?: string[] } = {}) {
  const store = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-video-tool-')));
  const client = {
    createVideoGeneration: vi.fn().mockResolvedValue(created),
    uploadFile: vi.fn().mockResolvedValue({ id: 'file-9', upload_url: '/upload', upload_url_expires_at: '' }),
    getFile: vi.fn().mockResolvedValue({ moderation_status: 'clean' }),
  };
  const track = vi.fn().mockImplementation(async input => ({ id: input.job.id, callId: input.callId }));
  const notices: ChatToolNotice[] = [];
  const media: MediaContext = {
    client: client as unknown as MediaApiClient,
    store,
    cdnUrl: '',
    notebookName: 'New chat',
    listImageModels: async () => [],
    listVideoModels: async () => options.models ?? [gemini, veo],
    videoJobs: { track },
    getRemoteSessionId: () => undefined,
    setRemoteSessionId: vi.fn(),
  };
  const context: ToolContext = {
    roots: options.roots ?? [],
    protectedPaths: options.protectedPaths ?? [],
    signal: new AbortController().signal,
    sessionId: SESSION,
    callId: 'call-1',
    media,
    report: {
      progress: () => undefined,
      media: () => undefined,
      notice: notice => notices.push(notice),
      label: () => undefined,
      moved: () => undefined,
      diff: () => undefined,
      detail: () => undefined,
      image: () => undefined,
    },
  };
  return { context, client, track, store, notices };
}

describe('generate_video approval', () => {
  it('states the model, settings and estimated credits, and that it spends them', async () => {
    const h = await harness();
    const { detail } = await generateVideoTool.approval!({ prompt: 'a red lighthouse' }, h.context);

    expect(detail).toContain('a 6s 16:9 720p video with Gemini Omni Flash (gemini-omni-1.1-flash)');
    // $0.1014/s x 6s at 2000 credits per dollar, rounded up by the shared estimateCost.
    expect(detail).toContain('Estimated cost: about 1,217 credits');
    expect(detail).toMatch(/spends credits on your Bike4Mind account/);
    expect(detail).toContain('a red lighthouse');
  });

  it('keys the approval on the whole request, so one approval never covers a different video', async () => {
    const h = await harness();
    const key = async (input: Record<string, unknown>) => (await generateVideoTool.approval!(input, h.context)).key;
    const first = await key({ prompt: 'a lighthouse' });

    expect(await key({ prompt: 'a lighthouse' })).toBe(first);
    expect(await key({ prompt: 'a lighthouse at night' })).not.toBe(first);
    expect(await key({ prompt: 'a lighthouse', durationSeconds: 8 })).not.toBe(first);
    expect(await key({ prompt: 'a lighthouse', aspectRatio: '9:16' })).not.toBe(first);
    expect(await key({ prompt: 'a lighthouse', model: veo.id })).not.toBe(first);
  });

  it('refuses a model the server does not offer before the user is asked to pay', async () => {
    const h = await harness({ models: [gemini] });
    await expect(generateVideoTool.approval!({ prompt: 'x', model: veo.id }, h.context)).rejects.toThrow(
      /does not offer the video model/
    );
  });

  it('refuses settings the shared rules reject, before asking', async () => {
    const h = await harness();
    await expect(
      generateVideoTool.approval!({ prompt: 'x', model: veo.id, durationSeconds: 5 }, h.context)
    ).rejects.toThrow(/unsupported_duration/);
  });
});

describe('generate_video run', () => {
  it('creates the job, records it for its card, and returns without waiting for the render', async () => {
    const h = await harness();
    const result = await generateVideoTool.run({ prompt: 'a red lighthouse' }, h.context);

    expect(h.client.createVideoGeneration).toHaveBeenCalledWith(
      {
        model: gemini.id,
        prompt: 'a red lighthouse',
        mode: 'text_to_video',
        duration_seconds: 6,
        aspect_ratio: '16:9',
        resolution: '720p',
      },
      'desktop-video:call-1'
    );
    expect(h.track).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, callId: 'call-1', job: created, estimatedCredits: 1217 })
    );
    expect(result).toContain('Started video job job-1');
    expect(result).toMatch(/do not wait for it/);
  });

  it('surfaces running out of credits as a notice, and records no job', async () => {
    const h = await harness();
    const { MediaToolError } = await import('../media/MediaApiClient');
    h.client.createVideoGeneration.mockRejectedValue(
      new MediaToolError('Not enough credits', { kind: 'insufficient-credits', text: 'Not enough credits.' })
    );

    await expect(generateVideoTool.run({ prompt: 'x' }, h.context)).rejects.toThrow(/Not enough credits/);
    expect(h.notices).toEqual([{ kind: 'insufficient-credits', text: 'Not enough credits.' }]);
    expect(h.track).not.toHaveBeenCalled();
  });

  it('animates an image generated earlier in this conversation', async () => {
    const h = await harness();
    const image = await h.store.save(SESSION, Buffer.from('png'), 'image/png');

    const { detail } = await generateVideoTool.approval!({ prompt: 'x', inputGeneratedImage: image.name }, h.context);
    expect(detail).toContain('Animates the generated image');
    await generateVideoTool.run({ prompt: 'x', inputGeneratedImage: image.name }, h.context);

    expect(h.client.uploadFile).toHaveBeenCalledWith(image.name, 'image/png', Buffer.from('png'));
    expect(h.client.createVideoGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'image_to_video', input_image_file_id: 'file-9' }),
      expect.any(String)
    );
  });

  it('refuses a generated-image id this conversation did not produce', async () => {
    const h = await harness();
    await expect(
      generateVideoTool.approval!({ prompt: 'x', inputGeneratedImage: '../../secrets.png' }, h.context)
    ).rejects.toThrow(/not an image generated in this conversation/);
  });

  it('animates a local image inside the shared folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-video-root-'));
    await writeFile(join(root, 'frame.jpg'), Buffer.from('jpeg'));
    const h = await harness({ roots: [root] });

    const { detail } = await generateVideoTool.approval!(
      { prompt: 'x', inputImagePath: 'frame.jpg' },
      {
        ...h.context,
        workingDirectory: root,
      }
    );
    expect(detail).toContain(join(root, 'frame.jpg'));
    await generateVideoTool.run({ prompt: 'x', inputImagePath: join(root, 'frame.jpg') }, h.context);
    expect(h.client.uploadFile).toHaveBeenCalledWith('frame.jpg', 'image/jpeg', Buffer.from('jpeg'));
  });

  it('refuses a local image outside the shared folders, or in a protected one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'b4m-video-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'b4m-video-outside-'));
    await writeFile(join(outside, 'frame.png'), Buffer.from('png'));
    const vault = join(root, 'userData');
    await mkdir(vault);
    await writeFile(join(vault, 'frame.png'), Buffer.from('png'));
    const h = await harness({ roots: [root], protectedPaths: [vault] });

    await expect(
      generateVideoTool.approval!({ prompt: 'x', inputImagePath: join(outside, 'frame.png') }, h.context)
    ).rejects.toThrow(/outside the folders shared/);
    await expect(
      generateVideoTool.approval!({ prompt: 'x', inputImagePath: join(vault, 'frame.png') }, h.context)
    ).rejects.toThrow(/protected location/);
    expect(h.client.uploadFile).not.toHaveBeenCalled();
  });

  it('starts no job when the uploaded image is blocked by the scan', async () => {
    const h = await harness();
    const image = await h.store.save(SESSION, Buffer.from('png'), 'image/png');
    h.client.getFile.mockResolvedValue({ moderation_status: 'blocked' });

    await expect(generateVideoTool.run({ prompt: 'x', inputGeneratedImage: image.name }, h.context)).rejects.toThrow(
      /refused the input image/
    );
    expect(h.client.createVideoGeneration).not.toHaveBeenCalled();
  });
});
