import { describe, expect, it, vi } from 'vitest';
import {
  listHandoffDevices,
  sendSessionHandoff,
  type HandoffAdapters,
  type HandoffDestination,
} from './sessionHandoff';

const sessionId = '0123456789abcdef01234567';
const destination: HandoffDestination = {
  id: 'live:1',
  name: 'Browser',
  platform: 'web',
  available: true,
  sid: 'signed-in',
  connectionId: 'socket',
};
function fixture(rows = [destination]) {
  const deps: HandoffAdapters = {
    destinations: vi.fn().mockResolvedValue(rows),
    authorizeSession: vi.fn().mockResolvedValue(undefined),
    liveSids: vi.fn().mockResolvedValue(new Set(['signed-in'])),
    sendLive: vi.fn(),
    sendPush: vi.fn(),
  };
  return deps;
}
describe('session handoff', () => {
  it('returns only the public device shape, never routing credentials', async () => {
    expect(await listHandoffDevices('user', fixture())).toEqual([
      { id: 'live:1', name: 'Browser', platform: 'web', available: true },
    ]);
  });
  it('authorizes the exact session before looking up destinations or sending', async () => {
    const deps = fixture();
    vi.mocked(deps.authorizeSession).mockRejectedValue(new Error('Forbidden'));
    await expect(sendSessionHandoff('user', { sessionId, deviceId: destination.id }, deps)).rejects.toThrow(
      'Forbidden'
    );
    expect(deps.destinations).not.toHaveBeenCalled();
    expect(deps.sendLive).not.toHaveBeenCalled();
  });
  it('directs an ID-only handoff to the chosen live destination', async () => {
    const deps = fixture();
    await sendSessionHandoff('user', { sessionId, deviceId: destination.id }, deps);
    expect(deps.destinations).toHaveBeenCalledWith('user');
    expect(deps.authorizeSession).toHaveBeenCalledWith('user', sessionId);
    expect(deps.sendLive).toHaveBeenCalledExactlyOnceWith('socket', sessionId);
    expect(deps.sendPush).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'inactive', 'signed-out'])(
    'refuses %s destinations with the same understandable feedback',
    async kind => {
      const deps = fixture(kind === 'unknown' ? [] : [{ ...destination, available: kind !== 'inactive' }]);
      if (kind === 'signed-out') vi.mocked(deps.liveSids).mockResolvedValue(new Set());
      await expect(sendSessionHandoff('user', { sessionId, deviceId: destination.id }, deps)).rejects.toThrow(
        /inactive/
      );
      expect(deps.sendLive).not.toHaveBeenCalled();
      expect(deps.sendPush).not.toHaveBeenCalled();
    }
  );
  it('targets one native registration and keeps transport identifiers out of the response', async () => {
    const deps = fixture([{ ...destination, connectionId: undefined, pushId: 'push-row', platform: 'ios' }]);
    await sendSessionHandoff('user', { sessionId, deviceId: destination.id }, deps);
    expect(deps.sendPush).toHaveBeenCalledExactlyOnceWith('user', 'push-row', sessionId, 'signed-in');
    expect(deps.sendLive).not.toHaveBeenCalled();
  });
  it('marks ended auth sessions inactive in listings', async () => {
    const deps = fixture();
    vi.mocked(deps.liveSids).mockResolvedValue(new Set());
    expect((await listHandoffDevices('user', deps))[0].available).toBe(false);
  });
});
