import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionFindOne: vi.fn(),
  sessionFindOne: vi.fn(),
  userFindById: vi.fn(),
  upsertVoiceTranscriptTurn: vi.fn(),
  ofType: vi.fn(),
  accessibleBy: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  Connection: { findOne: mocks.connectionFindOne },
  questRepository: { upsertVoiceTranscriptTurn: mocks.upsertVoiceTranscriptTurn },
  userRepository: { findById: mocks.userFindById },
}));

vi.mock('@bike4mind/database/auth', () => ({
  Session: { findOne: mocks.sessionFindOne },
}));

vi.mock('@casl/mongoose', () => ({
  accessibleBy: (...args: unknown[]) => {
    mocks.accessibleBy(...args);
    return { ofType: mocks.ofType };
  },
}));

vi.mock('@server/auth/ability', () => ({ default: vi.fn(() => ({})) }));

vi.mock('@server/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

import { Permission } from '@bike4mind/common';
import { func } from '../voiceSessionSendTranscript';

/**
 * The transcript write is the one Connection-only handler that both authorizes a WRITE and picks
 * the row it writes, so its two gaps are covered here: read-accessibility standing in for update
 * permission, and a socket's key scope never being consulted at all.
 */
describe('voiceSessionSendTranscript authorization', () => {
  const event = {
    requestContext: { connectionId: 'conn-1' },
    body: JSON.stringify({
      action: 'voice_session_send_transcript',
      userId: 'user-1',
      sessionId: 'session-1',
      transcript: 'hello there',
      type: 'input',
      conversationItemId: 'item-1',
    }),
  };
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectionFindOne.mockResolvedValue({ connectionId: 'conn-1', userId: 'user-1' });
    mocks.userFindById.mockResolvedValue({ id: 'user-1' });
    mocks.ofType.mockReturnValue({ scopeMarker: 'update-scope' });
    mocks.sessionFindOne.mockResolvedValue({ _id: 'session-1' });
    mocks.upsertVoiceTranscriptTurn.mockResolvedValue({});
  });

  const run = () => func(event as never, {} as never, logger as never);

  it('gates the write on update permission, not read accessibility', async () => {
    await run();

    expect(mocks.accessibleBy).toHaveBeenCalledWith(expect.anything(), Permission.update);
    expect(mocks.sessionFindOne).toHaveBeenCalledWith({ _id: 'session-1', scopeMarker: 'update-scope' });
  });

  it('binds the upsert to the caller so it cannot land on another user turn', async () => {
    await run();

    expect(mocks.upsertVoiceTranscriptTurn).toHaveBeenCalledWith(
      'session-1',
      'item-1',
      'user-1',
      expect.objectContaining({ prompt: 'hello there', type: 'voice_transcript' })
    );
  });

  it('writes nothing when the session is readable but not writable by the caller', async () => {
    // A sharee holding only [read, share] falls out of the accessibleBy(update) filter.
    mocks.sessionFindOne.mockResolvedValue(null);

    expect(await run()).toEqual({ statusCode: 200 });
    expect(mocks.upsertVoiceTranscriptTurn).not.toHaveBeenCalled();
  });

  it('writes nothing when the socket was opened with a bridge-only key', async () => {
    mocks.connectionFindOne.mockResolvedValue({
      connectionId: 'conn-1',
      userId: 'user-1',
      scopes: ['cc-bridge:connect'],
    });

    expect(await run()).toEqual({ statusCode: 200 });
    expect(mocks.sessionFindOne).not.toHaveBeenCalled();
    expect(mocks.upsertVoiceTranscriptTurn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ai:chat'), expect.anything());
  });

  it('writes nothing when the frame claims a different user than the socket owner', async () => {
    mocks.connectionFindOne.mockResolvedValue({ connectionId: 'conn-1', userId: 'someone-else' });

    expect(await run()).toEqual({ statusCode: 200 });
    expect(mocks.upsertVoiceTranscriptTurn as Mock).not.toHaveBeenCalled();
  });
});
