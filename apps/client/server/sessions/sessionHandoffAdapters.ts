import { isPushCategoryEnabled } from '@bike4mind/common';
import {
  Connection,
  authSessionRepository,
  pushTokenRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { Resource } from 'sst';
import { sendToConnection } from '@bike4mind/server-utils/websocket/utils';
import { NotificationEvents } from '@bike4mind/server-utils/utils/eventBus';
import { readApnsCredentials } from '@bike4mind/server-utils/utils/pushDelivery';
import { sessionDeepLink } from '@bike4mind/server-utils/utils/pushNotifications';
import { InactiveHandoffDeviceError, type HandoffAdapters } from './sessionHandoff';

const MAX_PUSH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function isHandoffPushEnabled(userId: string): Promise<boolean> {
  const user = await userRepository.findById(userId);
  return !!user && isPushCategoryEnabled(user.preferences?.pushNotifications, 'session_handoff');
}

export const sessionHandoffAdapters: HandoffAdapters = {
  async destinations(userId) {
    const [connections, tokens] = await Promise.all([
      Connection.find({
        userId,
        source: 'web',
        sid: { $exists: true },
        apiKeyId: { $exists: false },
        handoffPlatform: { $exists: true },
      }),
      pushTokenRepository.findByUser(userId, 'device'),
    ]);
    const pushEnabled = tokens.length > 0 && (await isHandoffPushEnabled(userId));
    const now = Date.now();
    const apns = readApnsCredentials() !== null;
    return [
      ...connections.map(row => ({
        id: `live:${row.id}`,
        name: `${row.handoffName ?? 'Browser'} (${row.id.slice(-6)})`,
        platform: row.handoffPlatform ?? ('web' as const),
        sid: row.sid!,
        connectionId: row.connectionId,
        clientId: row.handoffClientId,
        available: !!row.authExpiresAt && row.authExpiresAt.getTime() > now,
      })),
      ...tokens.map(row => ({
        id: `push:${row.id}`,
        name: `${row.platform === 'ios' ? 'iPhone / iPad' : 'Android (handoff not supported)'} (${row.id.slice(-6)})`,
        platform: row.platform,
        sid: row.sid,
        pushId: row.id,
        available: pushEnabled && row.lastSeenAt.getTime() > now - MAX_PUSH_AGE_MS && row.platform === 'ios' && apns,
      })),
    ];
  },
  async authorizeSession(userId, sessionId) {
    await sessionService.getSession(
      userId,
      { id: sessionId },
      { db: { sessions: sessionRepository, users: userRepository } }
    );
  },
  liveSids: sids => authSessionRepository.findLiveSids(sids),
  sendLive: (connectionId, sessionId) =>
    sendToConnection(connectionId, Resource.websocket.managementEndpoint, {
      action: 'session_handoff',
      sessionId,
    }),
  async dropLive(connectionId) {
    await Connection.deleteOne({ connectionId });
  },
  async sendPush(userId, destinationId, sessionId, destinationSid) {
    if (!(await isHandoffPushEnabled(userId))) throw new InactiveHandoffDeviceError();
    await NotificationEvents.Push.publish({
      userId,
      destinationId,
      destinationSid,
      sessionId,
      category: 'session_handoff',
      title: 'Continue your conversation',
      body: 'Tap to open the conversation you sent here.',
      deepLink: sessionDeepLink(sessionId),
      collapseId: `handoff:${destinationId}`,
    });
  },
};
