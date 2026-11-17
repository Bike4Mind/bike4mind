import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InactiveHandoffDeviceError, sendSessionHandoff } from './sessionHandoff';

type PreferenceUser = { preferences?: { pushNotifications?: { session_handoff?: boolean } } };
const h = vi.hoisted(() => ({
  connections: vi.fn(),
  tokens: vi.fn(),
  user: vi.fn<(userId: string) => Promise<PreferenceUser | null>>(),
  liveSids: vi.fn(),
  authorize: vi.fn(),
  publish: vi.fn(),
  sendLive: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  Connection: { find: h.connections },
  pushTokenRepository: { findByUser: h.tokens },
  userRepository: { findById: h.user },
  authSessionRepository: { findLiveSids: h.liveSids },
  sessionRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ sessionService: { getSession: h.authorize } }));
vi.mock('@bike4mind/resource', () => ({ Resource: { websocket: { managementEndpoint: 'https://example.invalid' } } }));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToConnection: h.sendLive }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ NotificationEvents: { Push: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/pushDelivery', () => ({
  readApnsCredentials: () => ({ teamId: 'fixture-team', keyId: 'fixture-key', privateKey: 'inert-test-value' }),
}));
import { sessionHandoffAdapters } from './sessionHandoffAdapters';

const USER = '0123456789abcdef01234567';
const SESSION = '1234567890abcdef12345678';
const PUSH = '2345678901abcdef23456789';
const live = {
  id: 'live-connection',
  connectionId: 'connection-id',
  sid: 'live-sid',
  handoffPlatform: 'desktop',
  handoffName: 'Desktop',
  authExpiresAt: new Date(Date.now() + 60_000),
};
const token = { id: PUSH, sid: 'push-sid', platform: 'ios', lastSeenAt: new Date() };
const userWith = (enabled: boolean): PreferenceUser => ({
  preferences: { pushNotifications: { session_handoff: enabled } },
});

beforeEach(() => {
  vi.resetAllMocks();
  h.connections.mockResolvedValue([live]);
  h.tokens.mockResolvedValue([token]);
  h.user.mockResolvedValue({});
  h.liveSids.mockResolvedValue(new Set(['live-sid', 'push-sid']));
  h.authorize.mockResolvedValue(undefined);
  h.publish.mockResolvedValue(undefined);
  h.sendLive.mockResolvedValue(undefined);
});

describe('session handoff persisted notification preference', () => {
  it.each(['missing', 'enabled'] as const)(
    'makes a configured native destination available with %s preference',
    async preference => {
      h.user.mockResolvedValue(preference === 'missing' ? {} : userWith(true));
      const devices = await sessionHandoffAdapters.destinations(USER);
      expect(devices.find(device => device.id === `push:${PUSH}`)?.available).toBe(true);
      await sendSessionHandoff(USER, { sessionId: SESSION, deviceId: `push:${PUSH}` }, sessionHandoffAdapters);
      expect(h.publish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          userId: USER,
          destinationId: PUSH,
          destinationSid: 'push-sid',
          sessionId: SESSION,
          category: 'session_handoff',
        })
      );
    }
  );

  it('disables only native push when the saved category is off', async () => {
    h.user.mockResolvedValue(userWith(false));
    const devices = await sessionHandoffAdapters.destinations(USER);
    expect(devices.find(device => device.id === `push:${PUSH}`)?.available).toBe(false);
    expect(devices.find(device => device.id === 'live:live-connection')?.available).toBe(true);
    await expect(
      sendSessionHandoff(USER, { sessionId: SESSION, deviceId: `push:${PUSH}` }, sessionHandoffAdapters)
    ).rejects.toBeInstanceOf(InactiveHandoffDeviceError);
    expect(h.publish).not.toHaveBeenCalled();
    await sendSessionHandoff(USER, { sessionId: SESSION, deviceId: 'live:live-connection' }, sessionHandoffAdapters);
    expect(h.sendLive).toHaveBeenCalledOnce();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rechecks a preference changed after destination and live-session admission', async () => {
    h.user.mockResolvedValue(userWith(true));
    h.liveSids.mockImplementationOnce(async () => {
      h.user.mockResolvedValue(userWith(false));
      return new Set(['push-sid']);
    });
    await expect(
      sendSessionHandoff(USER, { sessionId: SESSION, deviceId: `push:${PUSH}` }, sessionHandoffAdapters)
    ).rejects.toBeInstanceOf(InactiveHandoffDeviceError);
    expect(h.user).toHaveBeenCalledTimes(2);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('refuses a missing recipient both when listing and directly publishing', async () => {
    h.user.mockResolvedValue(null);
    expect(
      (await sessionHandoffAdapters.destinations(USER)).find(device => device.id === `push:${PUSH}`)?.available
    ).toBe(false);
    await expect(sessionHandoffAdapters.sendPush(USER, PUSH, SESSION, 'push-sid')).rejects.toBeInstanceOf(
      InactiveHandoffDeviceError
    );
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('does not read notification preferences for live-only destinations', async () => {
    h.tokens.mockResolvedValue([]);
    h.user.mockRejectedValue(new Error('No preference lookup expected for a live destination'));
    expect((await sessionHandoffAdapters.destinations(USER))[0].available).toBe(true);
    expect(h.user).not.toHaveBeenCalled();
  });
});
