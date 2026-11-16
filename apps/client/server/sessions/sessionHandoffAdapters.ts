import {
  Connection,
  authSessionRepository,
  pushTokenRepository,
  sessionRepository,
  userRepository,
} from '@bike4mind/database';
import { sessionService } from '@bike4mind/services';
import { Resource } from '@bike4mind/resource';
import { sendToConnection } from '@bike4mind/server-utils/websocket/utils';
import { NotificationEvents } from '@bike4mind/server-utils/utils/eventBus';
import { readApnsCredentials } from '@bike4mind/server-utils/utils/pushDelivery';
import { sessionDeepLink } from '@bike4mind/server-utils/utils/pushNotifications';
import type { HandoffAdapters } from './sessionHandoff';

const MAX_PUSH_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
    const now = Date.now();
    const apns = readApnsCredentials() !== null;
    return [
      ...connections.map(row => ({
        id: `live:${row.id}`,
        name: `${row.handoffName ?? 'Browser'} (${row.id.slice(-6)})`,
        platform: row.handoffPlatform ?? ('web' as const),
        sid: row.sid!,
        connectionId: row.connectionId,
        available: !!row.authExpiresAt && row.authExpiresAt.getTime() > now,
      })),
      ...tokens.map(row => ({
        id: `push:${row.id}`,
        name: `${row.platform === 'ios' ? 'iPhone / iPad' : 'Android (handoff not supported)'} (${row.id.slice(-6)})`,
        platform: row.platform,
        sid: row.sid,
        pushId: row.id,
        available: row.lastSeenAt.getTime() > now - MAX_PUSH_AGE_MS && row.platform === 'ios' && apns,
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
  async sendPush(userId, destinationId, sessionId, destinationSid) {
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
