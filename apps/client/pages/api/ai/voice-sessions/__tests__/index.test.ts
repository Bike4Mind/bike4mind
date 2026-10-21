import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { getSettingsMap, route } = vi.hoisted(() => ({
  getSettingsMap: vi.fn(),
  route: { handler: undefined as ((req: unknown, res: unknown) => unknown) | undefined },
}));

// baseApi installs connectDB + the auth chain; run the route's own handler directly instead.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = Object.assign(async (req: unknown, res: unknown) => route.handler?.(req, res), {
      post: (fn: (req: unknown, res: unknown) => unknown) => ((route.handler = fn), chain),
    });
    return chain;
  },
}));

vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => getSettingsMap(...a),
}));

import handler from '../index';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const run = () => {
  const { req, res } = createMocks({ method: 'POST', body: {} });
  Object.assign(req, { user: { id: 'u1', currentCredits: 100 }, logger: { error: vi.fn(), warn: vi.fn() } });
  return { promise: (handler as Handler)(req, res) };
};

describe('POST /api/ai/voice-sessions - admin settings read', () => {
  beforeEach(() => {
    getSettingsMap.mockReset().mockResolvedValue({ enableVoiceSession: 'false' });
  });

  // The handler reads these keys off one map. Under skipCache an unlisted key comes back absent
  // and silently reverts to its coded default - for voiceSessionTranscriptionModel that is
  // whisper-1, so a missing name would quietly downgrade every session's transcription.
  it('names every setting it reads and bypasses the process cache', async () => {
    await run().promise.catch(() => undefined);

    expect(getSettingsMap).toHaveBeenCalledWith(expect.anything(), {
      names: [
        'enableVoiceSession',
        'voiceSessionAiVoice',
        'voiceSessionVadType',
        'voiceSessionVadEagerness',
        'voiceSessionTranscriptionModel',
        'enforceCredits',
      ],
      skipCache: true,
    });
  });
});
