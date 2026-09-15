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

  it('sanitizes the provider error in the tool result (logs detail) without storing or billing', async () => {
    mockSynthesize.mockRejectedValue(new Error('provider exploded: key sk-abc123 rejected at https://api.example'));
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'boom' }, { ttsProvider: 'openai' });
    // The model sees a generic message; the raw vendor string (key hint / URL) must not leak.
    expect(result).toBe('Error: TTS request rejected by the openai provider.');
    expect(result).not.toMatch(/sk-abc123|api\.example/);
    // The detail is still logged for operators.
    expect(context.logger.error).toHaveBeenCalledWith(expect.stringContaining('provider exploded'));
    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
    // A failed generation must not settle a charge - onFinish is never reached.
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('rejects an over-length sound-effect description before gating or calling the provider', async () => {
    const context = createFakeContext();
    const result = await run(context, { kind: 'sound_effect', text: 'x'.repeat(1001) });
    expect(result).toMatch(/too long/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('rejects a model-supplied durationSeconds outside 0.5-30 before any paid call', async () => {
    // The model's own argument wins over audioConfig at resolution time, so the wire-schema
    // bound on it is what actually caps SFX cost - an out-of-range value must fail the parse
    // and never reach the provider (matches the direct /api/ai/sound-effects bound).
    const context = createFakeContext();
    const result = await run(context, { kind: 'sound_effect', text: 'dog barking', durationSeconds: 3600 });
    expect(result).toMatch(/invalid arguments/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('rejects speech longer than the resolved provider cap before the paid call', async () => {
    const context = createFakeContext();
    // OpenAI cap is 4096 chars.
    const result = await run(context, { kind: 'speech', text: 'a'.repeat(4097) }, { ttsProvider: 'openai' });
    expect(result).toMatch(/too long/i);
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('falls back to the other TTS provider (dropping the voice) when the preferred one has no key', async () => {
    // Preferred provider (openai) has no key; the other (elevenlabs) does.
    mockGetEffectiveApiKey.mockReset();
    mockGetEffectiveApiKey.mockResolvedValueOnce(undefined).mockResolvedValue('el-key');
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'read me' }, { ttsProvider: 'openai', voice: 'alloy' });

    // Resolved provider surfaces on the gate as elevenlabs, not the requested openai.
    expect(context.onStart).toHaveBeenCalledWith('audio_generation', {
      kind: 'speech',
      provider: 'elevenlabs',
      characters: 'read me'.length,
    });
    // Voice is provider-specific, so the openai voice is dropped for the fallback.
    expect(mockSynthesize).toHaveBeenCalledWith('read me', expect.objectContaining({ voice: undefined }));
    expect(result).toBe('Successfully generated speech');
  });

  it('drops a format the fallback provider cannot produce (openai default + flac -> ElevenLabs default)', async () => {
    // The exact user this fallback exists for: openai default + a format only openai supports
    // (flac) + an ElevenLabs-only key. ElevenLabs throws locally on an unmapped format, so the
    // format must be dropped alongside the voice or every call hard-fails.
    mockGetEffectiveApiKey.mockReset();
    mockGetEffectiveApiKey.mockResolvedValueOnce(undefined).mockResolvedValue('el-key');
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'read me' }, { ttsProvider: 'openai', format: 'flac' });

    expect(mockSynthesize).toHaveBeenCalledWith('read me', expect.objectContaining({ format: undefined }));
    expect(result).toBe('Successfully generated speech');
  });

  it('keeps a format the fallback provider does support (openai default + opus -> ElevenLabs opus)', async () => {
    // opus is in both providers' supported sets, so it should survive the fallback.
    mockGetEffectiveApiKey.mockReset();
    mockGetEffectiveApiKey.mockResolvedValueOnce(undefined).mockResolvedValue('el-key');
    const context = createFakeContext();
    await run(context, { kind: 'speech', text: 'read me' }, { ttsProvider: 'openai', format: 'opus' });
    expect(mockSynthesize).toHaveBeenCalledWith('read me', expect.objectContaining({ format: 'opus' }));
  });

  it('coerces a pcm format setting to mp3 (raw PCM has no container the inline player can decode)', async () => {
    const context = createFakeContext();
    await run(context, { kind: 'speech', text: 'hello' }, { ttsProvider: 'openai', format: 'pcm' });
    expect(mockSynthesize).toHaveBeenCalledWith('hello', expect.objectContaining({ format: 'mp3' }));
  });

  it('returns an actionable message (not the generic unavailable one) for a sound effect without an ElevenLabs key', async () => {
    // serverConfig advertises the tool available on an OpenAI-only key; the SFX branch still
    // hard-requires ElevenLabs, so the model must be told speech is the available fallback.
    mockGetEffectiveApiKey.mockReset();
    mockGetEffectiveApiKey.mockResolvedValue(undefined);
    const context = createFakeContext();
    const result = await run(context, { kind: 'sound_effect', text: 'dog barking' });
    expect(result).toBe('Error: sound effects require an ElevenLabs API key; speech (kind="speech") is available.');
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(context.onFinish).not.toHaveBeenCalled();
  });

  it('still fails when neither TTS provider has a key', async () => {
    mockGetEffectiveApiKey.mockReset();
    mockGetEffectiveApiKey.mockResolvedValue(undefined);
    const context = createFakeContext();
    const result = await run(context, { kind: 'speech', text: 'hi' }, { ttsProvider: 'openai' });
    expect(result).toMatch(/currently unavailable/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it('honors saveGeneratedAudio=false: uploads for inline playback but skips the KB FabFile copy', async () => {
    const context = createFakeContext();
    (context as { user: unknown }).user = { preferences: { saveGeneratedAudio: false } };
    const result = await run(context, { kind: 'speech', text: 'hello world' });
    expect(context.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
    expect(mockPersistFab).not.toHaveBeenCalled();
    expect(result).toBe('Successfully generated speech');
  });

  it('persists the KB FabFile copy when saveGeneratedAudio is unset (defaults on)', async () => {
    const context = createFakeContext();
    await run(context, { kind: 'speech', text: 'hello world' });
    expect(mockPersistFab).toHaveBeenCalledTimes(1);
  });
});
