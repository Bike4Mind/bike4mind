// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettingsMap: vi.fn(),
  getSettingsValue: vi.fn(),
  findTurns: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  questRepository: { findAllBySessionIdAndGreaterThanOrEqualToTimestamp: mocks.findTurns },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    warn = mocks.warn;
  },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...args: unknown[]) => mocks.getSettingsMap(...args),
  getSettingsValue: (...args: unknown[]) => mocks.getSettingsValue(...args),
}));

import { measureVoiceCallSeconds, PROVIDER_RECORD_GRACE_SECONDS } from './measureVoiceCall';

const STARTED = new Date('2026-10-11T12:00:00Z');
const secondsAfterStart = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);
const holdWith = (ids?: string[]) => ({
  id: 's1',
  userId: 'u1',
  voiceReservedCredits: 600,
  voiceSessionStartedAt: STARTED,
  voiceProviderConversationIds: ids,
});
const conversation = (status: string, call_duration_secs: number) =>
  new Response(JSON.stringify({ status, metadata: { call_duration_secs } }), { status: 200 });

describe('measureVoiceCallSeconds', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    mocks.getSettingsMap.mockResolvedValue({});
    mocks.getSettingsValue.mockReturnValue('xi-key');
    mocks.findTurns.mockResolvedValue([]);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('measures the wall clock, without asking the provider, when the hold has no provider ids', async () => {
    expect(await measureVoiceCallSeconds(holdWith(), secondsAfterStart(42.9))).toEqual({
      kind: 'measured',
      elapsedSeconds: 42,
      source: 'wall-clock',
    });
    expect(await measureVoiceCallSeconds(holdWith([]), secondsAfterStart(10))).toMatchObject({ source: 'wall-clock' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.getSettingsMap).not.toHaveBeenCalled();
  });

  it('never measures a negative wall clock when the clock is behind the hold start', async () => {
    expect(await measureVoiceCallSeconds(holdWith(), secondsAfterStart(-5))).toMatchObject({ elapsedSeconds: 0 });
  });

  it('sums the provider durations across conversations and rounds up', async () => {
    fetchSpy.mockResolvedValueOnce(conversation('done', 10.2)).mockResolvedValueOnce(conversation('processing', 20.5));

    const result = await measureVoiceCallSeconds(holdWith(['conv_a', 'conv_b']), secondsAfterStart(500));

    expect(result).toEqual({ kind: 'measured', elapsedSeconds: 31, source: 'provider' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/convai/conversations/conv_a',
      expect.objectContaining({ headers: { 'xi-api-key': 'xi-key' } })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/convai/conversations/conv_b',
      expect.anything()
    );
  });

  it.each(['in-progress', 'initiated'])('reports the call live while the provider status is %s', async status => {
    fetchSpy.mockResolvedValueOnce(conversation('done', 5)).mockResolvedValueOnce(conversation(status, 5));

    expect(await measureVoiceCallSeconds(holdWith(['conv_a', 'conv_b']), secondsAfterStart(500))).toEqual({
      kind: 'live',
    });
  });

  it('reports pending for a provider 404 inside the grace window', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }));

    expect(
      await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(PROVIDER_RECORD_GRACE_SECONDS - 1))
    ).toEqual({ kind: 'pending' });
  });

  it('bills zero seconds for a provider 404 past the grace window (the transport never connected)', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }));

    expect(
      await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(PROVIDER_RECORD_GRACE_SECONDS))
    ).toEqual({ kind: 'measured', elapsedSeconds: 0, source: 'provider' });
    expect(mocks.warn).toHaveBeenCalledWith(expect.any(String), { sessionId: 's1', conversationIds: ['conv_a'] });
  });

  // A v2 voice turn is an ordinary chat quest, so a message typed after a failed connect looks
  // like a call turn; it must not be billed as call time.
  it('does not bill session turns for a provider 404 past the grace window', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }));
    mocks.findTurns.mockResolvedValue([{ timestamp: secondsAfterStart(90) }]);

    expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(120))).toEqual({
      kind: 'measured',
      elapsedSeconds: 0,
      source: 'provider',
    });
    expect(mocks.findTurns).not.toHaveBeenCalled();
  });

  it('still counts the conversations the provider did record when another is missing past grace', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('', { status: 404 })).mockResolvedValueOnce(conversation('done', 12));

    expect(await measureVoiceCallSeconds(holdWith(['conv_a', 'conv_b']), secondsAfterStart(500))).toMatchObject({
      elapsedSeconds: 12,
    });
  });

  describe('unverifiable', () => {
    it('when no ElevenLabs server key is configured, without calling the provider', async () => {
      mocks.getSettingsValue.mockReturnValue(undefined);

      expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(500))).toMatchObject({
        kind: 'unverifiable',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('when the provider request throws', async () => {
      fetchSpy.mockRejectedValue(new Error('socket hang up'));

      expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(500))).toEqual({
        kind: 'unverifiable',
        reason: 'request failed: socket hang up',
      });
    });

    it('when the provider answers a non-404 error status', async () => {
      fetchSpy.mockResolvedValue(new Response('', { status: 500 }));

      expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(500))).toEqual({
        kind: 'unverifiable',
        reason: 'HTTP 500',
      });
    });

    it('when the provider answers an unexpected shape', async () => {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ status: 'done' }), { status: 200 }));

      expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(500))).toMatchObject({
        kind: 'unverifiable',
      });
    });

    it('when the provider answers a body that is not JSON', async () => {
      fetchSpy.mockResolvedValue(new Response('<html>', { status: 200 }));

      expect(await measureVoiceCallSeconds(holdWith(['conv_a']), secondsAfterStart(500))).toMatchObject({
        kind: 'unverifiable',
      });
    });

    it('when one conversation is measured but another lookup fails', async () => {
      fetchSpy.mockResolvedValueOnce(conversation('done', 5)).mockResolvedValueOnce(new Response('', { status: 503 }));

      expect(await measureVoiceCallSeconds(holdWith(['conv_a', 'conv_b']), secondsAfterStart(500))).toMatchObject({
        kind: 'unverifiable',
      });
    });
  });
});
