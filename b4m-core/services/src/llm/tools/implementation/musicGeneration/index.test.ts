import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '../../base/types';

// The tool resolves the ElevenLabs key via getEffectiveApiKey and generates via the
// aiMusicService vendor factory; both are mocked so no network/key is needed.
const mockGenerate = vi.fn();
const mockGetEffectiveApiKey = vi.fn();
const mockPersistFab = vi.fn().mockResolvedValue(undefined);

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return { ...actual, aiMusicService: vi.fn(() => ({ generate: mockGenerate })) };
});

vi.mock('../../../../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apiKeyService')>();
  return { ...actual, getEffectiveApiKey: mockGetEffectiveApiKey };
});

vi.mock('../../helpers/persistGeneratedFile', () => ({
  persistGeneratedFileAsFabFile: mockPersistFab,
}));

// Imported after the mocks so the tool picks up the mocked dependencies.
const { musicGenerationTool } = await import('./index');

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

function run(context: ToolContext, args: Record<string, unknown>) {
  return musicGenerationTool.implementation(context, undefined).toolFn(args);
}

describe('music_generation tool', () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    mockGetEffectiveApiKey.mockReset();
    mockPersistFab.mockClear();
    mockGenerate.mockResolvedValue({ audio: Buffer.from('fake-mp3'), contentType: 'audio/mpeg' });
    mockGetEffectiveApiKey.mockResolvedValue('el-key');
  });

  it('reserves credits, generates, stores the track, and renders it inline', async () => {
    const context = createFakeContext();
    const result = await run(context, { prompt: 'lofi study beats' });

    // Credit reservation runs first (onStart) with the deterministic length + provider.
    expect(context.onStart).toHaveBeenCalledWith('music_generation', {
      provider: 'elevenlabs',
      lengthMs: expect.any(Number),
      modelId: 'music_v1',
      prompt: 'lofi study beats',
    });

    // Stored in the generated-content bucket as an .mp3, with the audio Content-Type.
    expect(context.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
    const [, filename, options] = (context.imageGenerateStorage.upload as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filename).toMatch(/\.mp3$/);
    expect(options).toEqual({ ContentType: 'audio/mpeg' });

    // Inline render: path pushed via onFinish (host appends to quest.images) + statusUpdate.
    expect(context.onFinish).toHaveBeenCalledWith('music_generation', ['stored-key.mp3']);
    expect(context.statusUpdate).toHaveBeenCalledWith({ images: ['stored-key.mp3'] });
    expect(result).toBe('Successfully generated music');
  });

  it('clamps a below-minimum length up to the provider floor', async () => {
    const context = createFakeContext();
    await run(context, { prompt: 'ambient', lengthMs: 100 });
    const [, reserved] = (context.onStart as ReturnType<typeof vi.fn>).mock.calls[0];
    // MIN_MUSIC_LENGTH_MS is 3000; a 100ms request must be floored, not passed through.
    expect(reserved.lengthMs).toBe(3_000);
  });

  it('rejects an empty prompt without reserving credits or calling the provider', async () => {
    const context = createFakeContext();
    const result = await run(context, { prompt: '   ' });
    expect(result).toMatch(/non-empty music prompt/i);
    expect(context.onStart).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('fails with a generic message when no ElevenLabs key is configured', async () => {
    mockGetEffectiveApiKey.mockResolvedValue(undefined);
    const context = createFakeContext();
    await expect(run(context, { prompt: 'jazz' })).rejects.toThrow(/currently unavailable/i);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('returns the provider error as the tool result instead of throwing', async () => {
    mockGenerate.mockRejectedValue(new Error('provider exploded'));
    const context = createFakeContext();
    const result = await run(context, { prompt: 'techno' });
    expect(result).toMatch(/Error: provider exploded/);
    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
  });
});
