import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';
import type { AuthState } from '@shared/auth';
import type { HostBridgeResponse } from '@shared/hostBridge';
import type { HostEntry } from '@shared/hostConnection';
import { IPC_CHANNELS } from '@shared/ipc';
import { accountOf } from '../../host/auth/hostAccount';
import {
  HostServer,
  createInProcessTransport,
  type HostControl,
  type HostEventSource,
  type HostServerLogger,
  type HostServerRuntime,
} from '../../host/server';
import { appWindows } from '../windows';
import { ConnectionManager, LOCAL_HOST_ID, type HostClientEndpoint, type SystemSignals } from './ConnectionManager';

export type LocalHost = {
  runtime: HostServerRuntime;
  events: HostEventSource;
  logger: HostServerLogger;
};

export type HostConnectionsOptions = {
  /** The local host's `host/*` side; the handshake every host goes through needs it. */
  control: HostControl;
  auth: { getState(): AuthState };
  onAuthStateChanged(listener: (state: AuthState) => void): () => void;
  version: string;
  signals: SystemSignals;
};

const LOCAL_HOST_LABEL = 'This computer';

function endpointFor(contents: WebContents): HostClientEndpoint {
  return {
    id: contents.id,
    deliver: delivery => {
      if (!contents.isDestroyed()) contents.send(IPC_CHANNELS.hostNotification, delivery);
    },
    onClosed: listener => contents.once('destroyed', listener),
    isClosed: () => contents.isDestroyed(),
  };
}

function requireHostId(hostId: unknown): string {
  if (typeof hostId !== 'string') throw new Error(`Not a host id: ${String(hostId)}`);
  return hostId;
}

function broadcast(hosts: HostEntry[]): void {
  for (const window of appWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.hostStateChanged, hosts);
  }
}

/**
 * Registers this machine's runtime as the local host, which goes through the same handshake as a
 * remote one, and serves the renderer's host bridge and host list. A change of Desktop's account
 * (sign-out, another account or another environment) reconnects every remote host so its account
 * is checked again; a local host shares Desktop's sign-in and is left alone.
 */
export function registerHostConnections(local: LocalHost, options: HostConnectionsOptions): ConnectionManager {
  const { logger } = local;
  const server = new HostServer(local.runtime, local.events, logger, options.control);
  const manager = new ConnectionManager({
    // A fresh id per launch: a host tells this run's connections from an earlier run's.
    client: { clientId: randomUUID(), clientName: 'Bike4Mind Desktop', clientVersion: options.version },
    account: {
      current: () => accountOf(options.auth.getState()),
      onChanged: listener => options.onAuthStateChanged(state => listener(accountOf(state))),
    },
    signals: options.signals,
    log: message => logger.warn(message),
  });
  manager.onStateChanged(broadcast);
  manager.register(
    LOCAL_HOST_ID,
    {
      connect: async () =>
        createInProcessTransport(server, error =>
          logger.warn(
            `HOST: dropped a malformed notification: ${error instanceof Error ? error.message : String(error)}`
          )
        ),
    },
    { label: LOCAL_HOST_LABEL, kind: 'local' }
  );

  ipcMain.handle(
    IPC_CHANNELS.hostRequest,
    (event, hostId: unknown, method: unknown, params: unknown): Promise<HostBridgeResponse> =>
      manager.request(endpointFor(event.sender), hostId, method, params)
  );
  ipcMain.handle(IPC_CHANNELS.hostList, () => manager.list());
  ipcMain.handle(IPC_CHANNELS.hostConnect, (_event, hostId: unknown) => manager.connect(requireHostId(hostId)));
  ipcMain.handle(IPC_CHANNELS.hostDisconnect, (_event, hostId: unknown) => manager.disconnect(requireHostId(hostId)));
  ipcMain.handle(IPC_CHANNELS.hostRemove, (_event, hostId: unknown) => manager.remove(requireHostId(hostId)));
  return manager;
}
