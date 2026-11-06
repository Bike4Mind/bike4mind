import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ChatMedia, ChatToolNotice } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaApiClient } from '../media/MediaApiClient';
import { MediaStore } from '../media/MediaStore';
import { generateImageTool, generateSpeechTool, saveGeneratedImageTool } from './mediaTools';
import type { MediaContext, ToolContext } from './types';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

/** Real PNG and JPEG signatures: the tools sniff the bytes, not the name. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Harness {
  context: ToolContext;
  client: Record<string, ReturnType<typeof vi.fn>>;
  media: ChatMedia[];
  notices: ChatToolNotice[];
  progress: string[];
  setRemote: ReturnType<typeof vi.fn>;
  /** Images attached for the model to see, by media type. */
  shown: string[];
  /** A granted folder, for the save tool. */
  root: string;
}

async function harness(
  options: {
    imageModels?: string[];
    remoteSessionId?: string;
    vision?: boolean;
    generated?: 'png' | 'jpeg' | 'jpeg-as-png';
  } = {}
): Promise<Harness> {
  const client = {
    generateImage: vi.fn().mockResolvedValue({ questId: 'q1', remoteSessionId: 'nb1' }),
    getQuest: vi.fn().mockResolvedValue({
      id: 'q1',
      status: 'done',
      sessionId: 'nb1',
      files: [{ name: 'a.png', url: 'https://cdn.example/generated/a.png', isImage: true, isAudio: false }],
    }),
    fetchGenerated: vi
      .fn()
      .mockResolvedValue(
        options.generated === 'jpeg'
          ? { bytes: JPEG_BYTES, contentType: 'image/jpeg' }
          : options.generated === 'jpeg-as-png'
            ? { bytes: JPEG_BYTES, contentType: 'image/png' }
            : { bytes: PNG_BYTES, contentType: 'image/png' }
      ),
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
  const shown: string[] = [];
  const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-mediatools-root-')));

  const mediaContext: MediaContext = {
    client: client as unknown as MediaApiClient,
    store: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-mediatools-'))),
    cdnUrl: '',
    notebookName: 'New chat',
    listImageModels: async () => options.imageModels ?? ['gpt-image-2', 'gpt-image-1-mini'],
    listVideoModels: async () => [],
    getRemoteSessionId: () => options.remoteSessionId,
    setRemoteSessionId: setRemote,
  };

  return {
    client,
    media,
    notices,
    progress,
    setRemote,
    shown,
    root,
    context: {
      roots: [root],
      workingDirectory: root,
      signal: new AbortController().signal,
      sessionId: SESSION,
      media: mediaContext,
      images: {
        vision: options.vision ?? true,
        prepare: (bytes, mediaType) => ({
          bytes,
          mediaType,
          width: 1024,
          height: 1024,
          sourceWidth: 1024,
          sourceHeight: 1024,
        }),
      },
      report: {
        progress: text => progress.push(text),
        media: item => media.push(item),
        notice: notice => notices.push(notice),
        label: () => undefined,
        moved: () => undefined,
        ownContent: () => undefined,
        diff: () => undefined,
        detail: () => undefined,
        image: (_bytes, mimeType) => shown.push(mimeType),
      },
    },
  };
}

/** Run a generation and return the id it reported, the way the model would read it back. */
async function generate(h: Harness): Promise<string> {
  await generateImageTool.run({ prompt: 'a lantern' }, h.context);
  return h.media[0].url.split('/').pop() ?? '';
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

  it('reports the image to the UI and attaches it for the model to see', async () => {
    const h = await harness();
    const result = await generateImageTool.run({ prompt: 'a bicycle' }, h.context);

    expect(h.media).toHaveLength(1);
    expect(h.media[0]).toMatchObject({ kind: 'image', caption: 'a bicycle' });
    expect(h.shown).toEqual(['image/png']);
    expect(result).toMatch(/attached so you can see them too/);
    expect(result).toMatch(/shown again with the user's next\s+message/);
    expect(result).toContain(h.media[0].url.split('/').pop());
    // The local media URL is the renderer's business, never the model's.
    expect(result).not.toContain('b4m-media://');
  });

  it('tells a model that reads no images it was not shown the result, and not to describe it', async () => {
    const h = await harness({ vision: false });
    const result = await generateImageTool.run({ prompt: 'a bicycle' }, h.context);

    expect(h.media).toHaveLength(1);
    expect(h.shown).toEqual([]);
    expect(result).toMatch(/could not be shown the result: the current model does not accept images/);
    expect(result).toMatch(/Do not describe what you have not seen/);
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

describe('save_generated_image', () => {
  it('copies a generated image into the project, after naming the target in the approval', async () => {
    const h = await harness();
    const id = await generate(h);

    const prompt = await saveGeneratedImageTool.approval!({ id, path: 'refs/lantern.png' }, h.context);
    expect(prompt.detail).toContain(join(h.root, 'refs', 'lantern.png'));

    const result = await saveGeneratedImageTool.run({ id, path: 'refs/lantern.png' }, h.context);
    expect(result).toContain(join(h.root, 'refs', 'lantern.png'));
    expect(await readFile(join(h.root, 'refs', 'lantern.png'))).toEqual(PNG_BYTES);
  });

  // The save usually comes in a later turn than the generation, when the agent no longer sees the
  // image, so the save is what puts it back in front of the agent before it models from it.
  it('shows the saved image to the agent again', async () => {
    const h = await harness();
    const id = await generate(h);
    h.shown.length = 0;

    const result = await saveGeneratedImageTool.run({ id, path: 'refs/lantern.png' }, h.context);
    expect(h.shown).toEqual(['image/png']);
    expect(result).toMatch(/You see it below this result in this reply only/);
  });

  it('tells a model that reads no images it was not shown the saved image', async () => {
    const h = await harness({ vision: false });
    const id = await generate(h);

    const result = await saveGeneratedImageTool.run({ id, path: 'refs/lantern.png' }, h.context);
    expect(h.shown).toEqual([]);
    expect(result).toMatch(/could not be shown it: the current model does not accept images/);
  });

  // A viewer or slicer trusts the extension, so a JPEG saved as .png would open as a broken file.
  it('corrects the extension to the type the bytes really are', async () => {
    const h = await harness({ generated: 'jpeg' });
    const id = await generate(h);

    const result = await saveGeneratedImageTool.run({ id, path: 'lantern.png' }, h.context);
    expect(result).toContain(join(h.root, 'lantern.jpg'));
    expect(result).toMatch(/corrected/);
    expect(await readFile(join(h.root, 'lantern.jpg'))).toEqual(JPEG_BYTES);
  });

  it('trusts the bytes over the content type the server reported', async () => {
    const h = await harness({ generated: 'jpeg-as-png' });
    const id = await generate(h);

    const result = await saveGeneratedImageTool.run({ id, path: 'lantern.png' }, h.context);
    expect(result).toContain(join(h.root, 'lantern.jpg'));
    expect(await readFile(join(h.root, 'lantern.jpg'))).toEqual(JPEG_BYTES);
  });

  it('adds the extension when the path has none', async () => {
    const h = await harness();
    const id = await generate(h);
    await saveGeneratedImageTool.run({ id, path: 'lantern' }, h.context);
    expect(await readFile(join(h.root, 'lantern.png'))).toEqual(PNG_BYTES);
  });

  it('never replaces an existing file, and says so before the user is asked', async () => {
    const h = await harness();
    const id = await generate(h);
    await writeFile(join(h.root, 'lantern.png'), 'keep me');

    await expect(saveGeneratedImageTool.approval!({ id, path: 'lantern.png' }, h.context)).rejects.toThrow(
      /already exists/
    );
    expect(await readFile(join(h.root, 'lantern.png'), 'utf8')).toBe('keep me');
  });

  it('refuses a path outside the shared folders before the user is asked', async () => {
    const h = await harness();
    const id = await generate(h);
    const elsewhere = join(await realpath(tmpdir()), 'b4m-not-granted', 'lantern.png');

    await expect(saveGeneratedImageTool.approval!({ id, path: elsewhere }, h.context)).rejects.toThrow();
  });

  it('refuses an id this conversation did not generate', async () => {
    const h = await harness();
    await expect(
      saveGeneratedImageTool.approval!({ id: '00000000-0000-4000-8000-000000000000.png', path: 'x.png' }, h.context)
    ).rejects.toThrow(/not an image generated in this conversation/);
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
