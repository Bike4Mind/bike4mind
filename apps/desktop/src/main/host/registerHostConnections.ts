import { ipcMain, type WebContents } from 'electron';
import type { HostBridgeResponse } from '@shared/hostBridge';
import { IPC_CHANNELS } from '@shared/ipc';
import { HOST_ERROR_CODES } from '@shared/hostProtocol';
import {
  HostServer,
  createInProcessTransport,
  type HostEventSource,
  type HostServerLogger,
  type HostServerRuntime,
} from '../../host/server';
import { ConnectionManager, LOCAL_HOST_ID, type HostClientEndpoint } from './ConnectionManager';

export type LocalHost = { runtime: HostServerRuntime; events: HostEventSource; logger: HostServerLogger };

function endpointFor(contents: WebContents): HostClientEndpoint {
  return {
    id: contents.id,
    deliver: delivery => {
      if (!contents.isDestroyed()) contents.send(IPC_CHANNELS.hostNotification, delivery);
    },
    onClosed: listener => contents.once('destroyed', listener),
  };
}

/** Registers this machine's runtime as the local host and serves the renderer's host bridge. */
export function registerHostConnections(local: LocalHost): ConnectionManager {
  const { logger } = local;
  const server = new HostServer(local.runtime, local.events, logger);
  const manager = new ConnectionManager();
  manager.register(LOCAL_HOST_ID, {
    connect: () =>
      createInProcessTransport(server, error =>
        logger.warn(`HOST: dropped a malformed notification: ${error instanceof Error ? error.message : String(error)}`)
      ),
  });

  ipcMain.handle(
    IPC_CHANNELS.hostRequest,
    async (event, hostId: unknown, method: unknown, params: unknown): Promise<HostBridgeResponse> => {
      // A destroyed window never fires 'destroyed' again, so a connection opened for it would leak.
      if (event.sender.isDestroyed()) {
        return { ok: false, error: { code: HOST_ERROR_CODES.internalError, message: 'The window is gone' } };
      }
      return manager.request(endpointFor(event.sender), hostId, method, params);
    }
  );
  return manager;
}
