import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../base/types';
import type { AudioGenerationToolCall } from '@bike4mind/common';

// The tool resolves provider keys via getEffectiveApiKey and generates via the
// aiVoiceService / aiSoundService vendor factories; all mocked so no network/key is needed.
const mockSynthesize = vi.fn();
const mockGenerate = vi.fn();
const mockGetEffectiveApiKey = vi.fn();
const mockPersistFab = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    aiVoiceService: vi.fn(() => ({ synthesize: mockSynthesize })),
    aiSoundService: vi.fn(() => ({ generate: mockGenerate })),
  };
});

vi.mock('../../../../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apiKeyService')>();
  return { ...actual, getEffectiveApiKey: mockGetEffectiveApiKey };
});

vi.mock('../../helpers/persistGeneratedFile', () => ({
  persistGeneratedFileAsFabFile: mockPersistFab,
}));

// Imported after the mocks so the tool picks up the mocked dependencies.
const { audioGenerationTool } = await import('./index');

function createFakeContext(): ToolContext & {
  onStart: ReturnType<typeof vi.fn>;
  onFinish: ReturnType<typeof vi.fn>;
  statusUpdate: ReturnType<typeof vi.fn>;
} {
  return {
    userId: 'u1',
    user: {} as ToolContext['user'],
    sessionId: 's1',
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } as unknown as ToolContext['logger'],
    db: {} as ToolContext['db'],
    storage: {} as ToolContext['storage'],
    imageGenerateStorage: {
      upload: vi.fn().mockResolvedValue('stored-key.mp3'),
      getSignedUrl: vi.fn(),
      getPublicUrl: vi.fn(),
    },
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    onStart: vi.fn().mockResolvedValue(undefined),
    onFinish: vi.fn().mockResolvedValue(undefined),
    llm: {} as ToolContext['llm'],
  } as never;
}

function run(context: ToolContext, args: Record<string, unknown>, config?: AudioGenerationToolCall) {
  return audioGenerationTool.implementation(context, config).toolFn(args);
}

describe('audio_generation tool', () => {
  beforeEach(() => {
    mockSynthesize.mockReset();
    mockGenerate.mockReset();
    mockGetEffectiveApiKey.mockReset();
    mockPersistFab.mockClear();
    mockSynthesize.mockResolvedValue({
      audio: Buffer.from('fake-mp3'),
      contentType: 'audio/mpeg',
      format: 'mp3',
      model: 'tts-1',
      characters: 11,
    });
    mockGenerate.mockResolvedValue({ audio: Buffer.from('fake-sfx'), contentType: 'audio/mpeg' });
    mockGetEffectiveApiKey.mockResolvedValue('provider-key');
  });

  it('generates speech, stores it inline, and settles on the resolved model + characters', async () => {
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'hello world' }, { ttsProvider: 'openai' });

    // Affordability gate runs first (onStart) on the input character count.
    expect(context.onStart).toHaveBeenCalledWith('audio_generation', {
      kind: 'speech',
      provider: 'openai',
      characters: 'hello world'.length,
    });

    // Stored in the generated-content bucket as an .mp3 with the audio Content-Type.
    const [, filename, options] = (context.imageGenerateStorage.upload as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filename).toMatch(/\.mp3$/);
    expect(options).toEqual({ ContentType: 'audio/mpeg' });

    // Settlement carries the ACTUAL resolved model + character count (matches /api/ai/tts).
    expect(context.onFinish).toHaveBeenCalledWith('audio_generation', {
      kind: 'speech',
      provider: 'openai',
      model: 'tts-1',
      characters: 11,
      paths: ['stored-key.mp3'],
    });
    expect(context.statusUpdate).toHaveBeenCalledWith({ images: ['stored-key.mp3'] });
    expect(result).toBe('Successfully generated speech');
  });

  it('defaults to speech when kind is omitted', async () => {
    const context = createFakeContext();
    await run(context, { text: 'narrate this' });
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('generates a sound effect via ElevenLabs and threads the duration through', async () => {
    const context = createFakeContext();
    const result = await run(context, { kind: 'sound_effect', text: 'dog barking', durationSeconds: 5 });

    expect(context.onStart).toHaveBeenCalledWith('audio_generation', {
      kind: 'sound_effect',
      provider: 'elevenlabs',
      durationSeconds: 5,
    });
    expect(mockGenerate).toHaveBeenCalledWith('dog barking', { durationSeconds: 5, promptInfluence: undefined });
    expect(context.onFinish).toHaveBeenCalledWith('audio_generation', {
      kind: 'sound_effect',
      provider: 'elevenlabs',
      durationSeconds: 5,
      paths: ['stored-key.mp3'],
    });
    expect(result).toBe('Successfully generated sound effect');
  });

  it('rejects empty text without gating credits or calling a provider', async () => {
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: '   ' });
    expect(result).toMatch(/non-empty text/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('checks the key before the affordability gate, so a keyless caller never reaches onStart', async () => {
    mockGetEffectiveApiKey.mockResolvedValue(undefined);
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'hi' });
    expect(result).toMatch(/currently unavailable/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
    // A missing key must never settle a charge.
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('returns the provider error as the tool result without storing or billing', async () => {
    mockSynthesize.mockRejectedValue(new Error('provider exploded'));
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'boom' });
    expect(result).toMatch(/Error: provider exploded/);
    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
    // A failed generation must not settle a charge - onFinish is never reached.
    expect(context.onFinish).not.toHaveBeenCalled();
  });
});
