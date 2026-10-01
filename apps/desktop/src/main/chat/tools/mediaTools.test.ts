import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ChatMedia, ChatToolNotice } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaApiClient } from '../media/MediaApiClient';
import { MediaStore } from '../media/MediaStore';
import { generateImageTool, generateSpeechTool } from './mediaTools';
import type { MediaContext, ToolContext } from './types';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

interface Harness {
  context: ToolContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
  media: ChatMedia[];
  notices: ChatToolNotice[];
  progress: string[];
  setRemote: ReturnType<typeof vi.fn>;
}

async function harness(options: { imageModels?: string[]; remoteSessionId?: string } = {}): Promise<Harness> {
  const client = {
    generateImage: vi.fn().mockResolvedValue({ questId: 'q1', remoteSessionId: 'nb1' }),
    getQuest: vi.fn().mockResolvedValue({
      id: 'q1',
      status: 'done',
      sessionId: 'nb1',
      files: [{ name: 'a.png', url: 'https://cdn.example/generated/a.png', isImage: true, isAudio: false }],
    }),
    fetchGenerated: vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), contentType: 'image/png' }),
    synthesizeSpeech: vi.fn().mockResolvedValue({
      audio: Buffer.from('id3').toString('base64'),
      format: 'mp3',
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'fab1',
    }),
  };

  const media: ChatMedia[] = [];
  const notices: ChatToolNotice[] = [];
  const progress: string[] = [];
  const setRemote = vi.fn().mockResolvedValue(undefined);

  const mediaContext: MediaContext = {
    client: client as unknown as MediaApiClient,
    store: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-mediatools-'))),
    cdnUrl: '',
    notebookName: 'New chat',
    listImageModels: async () => options.imageModels ?? ['gpt-image-2', 'gpt-image-1-mini'],
    getRemoteSessionId: () => options.remoteSessionId,
    setRemoteSessionId: setRemote,
  };

  return {
    client,
    media,
    notices,
    progress,
    setRemote,
    context: {
      roots: [],
      signal: new AbortController().signal,
      sessionId: SESSION,
      media: mediaContext,
      report: {
        progress: text => progress.push(text),
        media: item => media.push(item),
        notice: notice => notices.push(notice),
        label: () => undefined,
        moved: () => undefined,
        diff: () => undefined,
        detail: () => undefined,
        image: () => undefined,
      },
    },
  };
}

describe('generate_image', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('asks the user to approve the spend, naming the model it will bill for', async () => {
    const h = await harness();
    const prompt = await generateImageTool.approval!({ prompt: 'a bicycle', size: '1024x1024' }, h.context);

    expect(prompt.detail).toContain('gpt-image-1-mini');
    expect(prompt.detail).toContain('1024x1024');
    expect(prompt.detail).toMatch(/spends credits/);
    expect(prompt.detail).toContain('a bicycle');
  });

  // "Always in this chat" must not carry a cheap generation's approval over to an expensive one.
  it('keys the approval on the whole request, so a different prompt asks again', async () => {
    const h = await harness();
    const first = await generateImageTool.approval!({ prompt: 'a bicycle' }, h.context);
    const same = await generateImageTool.approval!({ prompt: 'a bicycle' }, h.context);
    const other = await generateImageTool.approval!({ prompt: 'a bicycle, but gold' }, h.context);
    const bigger = await generateImageTool.approval!({ prompt: 'a bicycle', size: '2048x2048' }, h.context);

    expect(first.key).toBe(same.key);
    expect(other.key).not.toBe(first.key);
    expect(bigger.key).not.toBe(first.key);
  });

  it('prefers the cheap default when the server offers it, and the first model otherwise', async () => {
    const withDefault = await harness();
    expect((await generateImageTool.approval!({ prompt: 'x' }, withDefault.context)).detail).toContain(
      'gpt-image-1-mini'
    );

    const without = await harness({ imageModels: ['flux-pro'] });
    expect((await generateImageTool.approval!({ prompt: 'x' }, without.context)).detail).toContain('flux-pro');
  });

  it('refuses a model the server does not offer, before the user is asked to pay for it', async () => {
    const h = await harness();
    await expect(generateImageTool.approval!({ prompt: 'x', model: 'midjourney' }, h.context)).rejects.toThrow(
      /does not offer.*gpt-image-2, gpt-image-1-mini/s
    );
  });

  it('refuses when the deployment offers no image model at all', async () => {
    const h = await harness({ imageModels: [] });
    await expect(generateImageTool.approval!({ prompt: 'x' }, h.context)).rejects.toThrow(/no image-generation/);
  });

  it('reports the image to the UI and tells the model it cannot see it', async () => {
    const h = await harness();
    const result = await generateImageTool.run({ prompt: 'a bicycle' }, h.context);

    expect(h.media).toHaveLength(1);
    expect(h.media[0]).toMatchObject({ kind: 'image', caption: 'a bicycle' });
    expect(result).toMatch(/cannot see the result/);
    // The bytes are never handed to the model - only the fact that they exist.
    expect(result).not.toContain('b4m-media://');
  });

  it('remembers the notebook the server filed the first generation under', async () => {
    const fresh = await harness();
    await generateImageTool.run({ prompt: 'x' }, fresh.context);
    expect(fresh.setRemote).toHaveBeenCalledWith('nb1');

    const returning = await harness({ remoteSessionId: 'nb1' });
    await generateImageTool.run({ prompt: 'x' }, returning.context);
    expect(returning.setRemote).not.toHaveBeenCalled();
  });

  it('refuses without a signed-in session rather than failing at the network', async () => {
    const context: ToolContext = { roots: [], signal: new AbortController().signal };
    await expect(generateImageTool.run({ prompt: 'x' }, context)).rejects.toThrow(/not signed in/);
  });
});

describe('generate_speech', () => {
  it('states the character count and provider in the approval', async () => {
    const h = await harness();
    const prompt = await generateSpeechTool.approval!({ text: 'hello there', voice: 'nova' }, h.context);

    expect(prompt.detail).toContain('11 characters');
    expect(prompt.detail).toContain('openai');
    expect(prompt.detail).toContain('nova');
    expect(prompt.detail).toMatch(/spends credits/);
  });

  it('gives the user a player and reports the saved copy back to the model', async () => {
    const h = await harness();
    const result = await generateSpeechTool.run({ text: 'hello there' }, h.context);

    expect(h.media[0]).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      caption: 'hello there',
      fabFileId: 'fab1',
    });
    expect(result).toMatch(/fab1/);
    expect(result).toMatch(/cannot hear it/);
  });

  it('raises a substituted provider to its own state instead of burying it in the result', async () => {
    const h = await harness();
    h.client.synthesizeSpeech.mockResolvedValue({
      audio: Buffer.from('id3').toString('base64'),
      format: 'mp3',
      contentType: 'audio/mpeg',
      provider: 'elevenlabs',
      fallbackFrom: 'openai',
    });

    const result = await generateSpeechTool.run({ text: 'hello' }, h.context);
    expect(h.notices).toEqual([{ kind: 'provider-substituted', text: expect.stringContaining('elevenlabs') }]);
    // Also in the text, so the model knows the voice is not the one it chose.
    expect(result).toContain('elevenlabs');
  });

  it('raises credit exhaustion to its own state on the failure path too', async () => {
    const h = await harness();
    const response = {
      status: 422,
      data: { error: 'Not enough credits.', errorCode: 'insufficient_credits' },
      statusText: '',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    };
    const { toMediaError } = await import('../media/MediaApiClient');
    h.client.synthesizeSpeech.mockRejectedValue(
      toMediaError(new AxiosError('rejected', '422', undefined, undefined, response), 'Speech synthesis')
    );

    await expect(generateSpeechTool.run({ text: 'hello' }, h.context)).rejects.toThrow(/Not enough credits/);
    expect(h.notices).toEqual([{ kind: 'insufficient-credits', text: 'Not enough credits.' }]);
  });

  it('refuses text past the provider limit before asking the user to pay for a 422', async () => {
    const h = await harness();
    await expect(generateSpeechTool.run({ text: 'a'.repeat(5000) }, h.context)).rejects.toThrow(
      /openai accepts at most 4096/
    );
    expect(h.client.synthesizeSpeech).not.toHaveBeenCalled();
  });
});
