import { GoneException } from '@aws-sdk/client-apigatewaymanagementapi';
import type { HandoffDevice } from '@bike4mind/common';

export type HandoffDestination = HandoffDevice & { sid: string; connectionId?: string; pushId?: string };
export type HandoffAdapters = {
  destinations(userId: string): Promise<HandoffDestination[]>;
  authorizeSession(userId: string, sessionId: string): Promise<void>;
  liveSids(sids: string[]): Promise<ReadonlySet<string>>;
  sendLive(connectionId: string, sessionId: string): Promise<void>;
  sendPush(userId: string, destinationId: string, sessionId: string, sid: string): Promise<void>;
};

export class InactiveHandoffDeviceError extends Error {
  constructor() {
    super('This device looks inactive. Open it, sign in, and try again.');
  }
}

export async function listHandoffDevices(userId: string, deps: HandoffAdapters): Promise<HandoffDevice[]> {
  const rows = await deps.destinations(userId);
  const live = await deps.liveSids([...new Set(rows.map(row => row.sid))]);
  return rows.map(({ id, name, platform, available, sid }) => ({
    id,
    name,
    platform,
    available: available && live.has(sid),
  }));
}

export async function sendSessionHandoff(
  userId: string,
  request: { deviceId: string; sessionId: string },
  deps: HandoffAdapters
): Promise<void> {
  await deps.authorizeSession(userId, request.sessionId);
  const destination = (await deps.destinations(userId)).find(row => row.id === request.deviceId);
  if (!destination || !destination.available || !(await deps.liveSids([destination.sid])).has(destination.sid)) {
    throw new InactiveHandoffDeviceError();
  }
  if (destination.connectionId) {
    try {
      await deps.sendLive(destination.connectionId, request.sessionId);
    } catch (error) {
      if (error instanceof GoneException) throw new InactiveHandoffDeviceError();
      throw error;
    }
  } else if (destination.pushId) {
    await deps.sendPush(userId, destination.pushId, request.sessionId, destination.sid);
  } else {
    throw new InactiveHandoffDeviceError();
  }
}
