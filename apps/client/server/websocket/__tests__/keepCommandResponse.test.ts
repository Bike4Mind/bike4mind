import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('@bike4mind/database/social', () => ({
  Connection: { findOne: vi.fn() },
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToConnection: vi.fn(),
}));

import { Connection } from '@bike4mind/database/social';
import { sendToConnection } from '@server/websocket/utils';
import { func } from '../keepCommandResponse';

/**
 * `originConnectionId` is client-supplied. The sender's own Connection row proves who is
 * SPEAKING, never who may be spoken TO, so the destination has to be resolved and matched.
 */
describe('keepCommandResponse relay target', () => {
  const event = {
    requestContext: { connectionId: 'cli-conn', domainName: 'ws.example.com', stage: 'dev' },
    body: JSON.stringify({
      action: 'keep_command_response',
      requestId: 'req-1',
      originConnectionId: 'hud-conn',
      success: true,
      result: { ok: true },
    }),
  };
  const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

  const connectionsByIdReturning = (rows: Record<string, { userId: string } | null>) =>
    (Connection.findOne as Mock).mockImplementation(
      async ({ connectionId }: { connectionId: string }) => rows[connectionId] ?? null
    );

  beforeEach(() => vi.clearAllMocks());

  it('relays to an origin connection owned by the same user', async () => {
    connectionsByIdReturning({ 'cli-conn': { userId: 'user-1' }, 'hud-conn': { userId: 'user-1' } });

    expect(await func(event as never, {} as never, logger as never)).toEqual({ statusCode: 200 });
    expect(sendToConnection).toHaveBeenCalledWith(
      'hud-conn',
      'https://ws.example.com/dev',
      expect.objectContaining({ action: 'keep_command_result', requestId: 'req-1', success: true })
    );
  });

  it('drops a relay aimed at a connection owned by another user', async () => {
    connectionsByIdReturning({ 'cli-conn': { userId: 'user-1' }, 'hud-conn': { userId: 'victim' } });

    expect(await func(event as never, {} as never, logger as never)).toEqual({ statusCode: 200 });
    expect(sendToConnection).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('belongs to another user'));
  });

  it('drops a relay aimed at an unknown connection', async () => {
    connectionsByIdReturning({ 'cli-conn': { userId: 'user-1' } });

    expect(await func(event as never, {} as never, logger as never)).toEqual({ statusCode: 200 });
    expect(sendToConnection).not.toHaveBeenCalled();
  });

  it('drops the frame when the sender itself has no connection row', async () => {
    connectionsByIdReturning({ 'hud-conn': { userId: 'user-1' } });

    expect(await func(event as never, {} as never, logger as never)).toEqual({ statusCode: 200 });
    expect(sendToConnection).not.toHaveBeenCalled();
  });
});
