import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MediaApiClient } from '../media/MediaApiClient';
import { MediaStore } from '../media/MediaStore';
import { generateMusicTool } from './mediaTools';
import type { ToolContext } from './types';

const model = (id: string, preview: boolean, overrides: Record<string, unknown> = {}) => ({
  id,
  display_name: `Name ${id}`,
  preview,
  vocals: 'optional',
  duration: { control: 'approximate', min: 10, max: 180, default: 60 },
  pricing: { unit: 'per_song', credits: 1200 },
  ...overrides,
});

const readyJob = {
  id: 'job-1',
  state: 'succeeded',
  output: { availability: 'ready', url: 'https://cdn.example/s.mp3', content_type: 'audio/mpeg', file_id: 'f1' },
};

async function setup(models: ReturnType<typeof model>[]) {
  const client = {
    listMusicModels: vi.fn().mockResolvedValue(models),
    createMusicGeneration: vi.fn().mockResolvedValue(readyJob),
    getMusicGeneration: vi.fn().mockResolvedValue(readyJob),
    fetchGenerated: vi.fn().mockResolvedValue({ bytes: Buffer.from('mp3'), contentType: 'audio/mpeg' }),
  };
  const context = {
    roots: [],
    signal: new AbortController().signal,
    sessionId: 'f1a2b3c4-0000-4000-8000-000000000001',
    media: {
      client: client as unknown as MediaApiClient,
      store: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-music-'))),
    },
  } as unknown as ToolContext;
  return { client, context };
}

describe('generate_music', () => {
  it('names the model and length on the approval card and keys on every parameter', async () => {
    const { context } = await setup([model('preview-1', true), model('lyria', false)]);
    const card = await generateMusicTool.approval!({ prompt: 'lo-fi', durationSeconds: 45 }, context);
    expect(card.detail).toContain('45s of music');
    expect(card.detail).toContain('Name lyria');

    const base = await generateMusicTool.approval!({ prompt: 'lo-fi' }, context);
    expect(base.detail).toContain('60s of music');
    expect(base.detail).toContain('Estimated cost: about 1,200 credits');
    expect(base.detail).toContain('spends credits');
    const keys = [
      card.key,
      base.key,
      (await generateMusicTool.approval!({ prompt: 'lo-fi', instrumental: true }, context)).key,
      (await generateMusicTool.approval!({ prompt: 'lo-fi', instrumental: false }, context)).key,
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('prices per second on the effective length and validates against the model', async () => {
    const perSecond = model('m', false, {
      vocals: 'never',
      pricing: { unit: 'per_second', credits: 2 },
      duration: { control: 'exact', min: 10, max: 60, default: 30 },
    });
    const { context } = await setup([perSecond]);
    expect((await generateMusicTool.approval!({ prompt: 'x' }, context)).detail).toContain('about 60 credits');
    expect((await generateMusicTool.approval!({ prompt: 'x', durationSeconds: 45 }, context)).detail).toContain(
      'about 90 credits'
    );
    await expect(generateMusicTool.approval!({ prompt: 'x', durationSeconds: 90 }, context)).rejects.toThrow(/10-60s/);
    await expect(generateMusicTool.approval!({ prompt: 'x', instrumental: false }, context)).rejects.toThrow(
      /only makes instrumental/
    );
  });

  it('falls back to the first model when every one is a preview', async () => {
    const { context } = await setup([model('a', true), model('b', true)]);
    expect((await generateMusicTool.approval!({ prompt: 'x' }, context)).detail).toContain('Name a');
  });

  it('skips the non-production test model when a real one is offered', async () => {
    const { context } = await setup([
      model('test-music', false, { provider: 'test' }),
      model('music_v2_5', false, { provider: 'elevenlabs' }),
    ]);
    expect((await generateMusicTool.approval!({ prompt: 'x' }, context)).detail).toContain('Name music_v2_5');
  });

  it('uses the test model when it is the only one offered', async () => {
    const { context } = await setup([model('test-music', false, { provider: 'test' })]);
    expect((await generateMusicTool.approval!({ prompt: 'x' }, context)).detail).toContain('Name test-music');
  });

  it('refuses when the server offers no music model', async () => {
    const { context } = await setup([]);
    await expect(generateMusicTool.approval!({ prompt: 'x' }, context)).rejects.toThrow(
      'No music models are available on this server.'
    );
  });

  it('rejects a fractional duration', async () => {
    const { context } = await setup([model('m', false)]);
    await expect(generateMusicTool.approval!({ prompt: 'x', durationSeconds: 1.5 }, context)).rejects.toThrow(
      /whole number/
    );
  });

  it('runs the job with the resolved model and reports the player', async () => {
    const { client, context } = await setup([model('m', false)]);
    const media: unknown[] = [];
    context.callId = 'call-7';
    context.report = {
      media: (item: unknown) => media.push(item),
      progress: () => undefined,
    } as unknown as ToolContext['report'];
    const result = await generateMusicTool.run({ prompt: 'lo-fi', durationSeconds: 30, instrumental: true }, context);

    expect(client.createMusicGeneration.mock.calls[0][0]).toEqual({
      model: 'm',
      prompt: 'lo-fi',
      duration_seconds: 30,
      instrumental: true,
    });
    expect(client.createMusicGeneration.mock.calls[0][1]).toBe('desktop-music:call-7');
    expect(media).toHaveLength(1);
    expect(result).toMatch(/30s of music.*Saved to the file browser as f1/);
  });
});
