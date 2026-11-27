import { join } from 'node:path';
import type { AuthState } from '@shared/auth';
import type { HostCapability } from '@shared/hostProtocol';
import { AttachmentStore } from '../../main/chat/AttachmentStore';
import { ModelCatalog } from '../../main/chat/ModelCatalog';
import { createHeadlessHostAuth, type HeadlessHostAuth, type HeadlessHostAuthOptions } from '../auth/HeadlessHostAuth';
import { ensurePrivateDirectory } from '../auth/privateDirectory';
import { HostRuntime } from '../HostRuntime';
import { createHostPermissionStack } from '../permissionStack';
import type { HostEnvironment, HostEventSink } from '../ports';
import { hostProtectedLocations } from '../protection';
import { createHostControl, HostEventRelay, HostServer } from '../server';
import { loadHostId } from '../hostIdentity';
import type { HostLogger } from './logging';

/**
 * What the headless host offers. It leaves out everything that needs a desktop session or a
 * feature not composed here (see composeHeadlessHost), so a client can hide those controls.
 */
export const HEADLESS_HOST_CAPABILITIES = [
  'queue',
  'backgroundProcesses',
  'attachments',
] as const satisfies readonly HostCapability[];

export type HeadlessHostOptions = {
  /** Holds every store of this host; created 0700. Never the Desktop app's own data folder. */
  dataDirectory: string;
  homeDirectory: string;
  /** This build's version, reported in host/info and sent as the sign-in user agent. */
  version: string;
  logger: HostLogger;
  /** Seams for tests; a real host uses the device flow and API client AuthService builds. */
  auth?: Pick<HeadlessHostAuthOptions, 'createDeviceFlowClient' | 'createApiClient'>;
};

export type HeadlessHost = {
  readonly hostId: string;
  readonly server: HostServer;
  readonly runtime: HostRuntime;
  readonly auth: HeadlessHostAuth;
  /** Stops the server, the runtime's work and the auth timers. */
  dispose(): void;
};

// The runtime's pushes all reach clients through the relay; there is no app window to send them to.
const noWindowSink: HostEventSink = {
  streamEvent: () => undefined,
  sessionSummary: () => undefined,
  sessionStatus: () => undefined,
  queueChanged: () => undefined,
  taskDecisions: () => undefined,
  loopChanged: () => undefined,
};

/**
 * Builds the host runtime with no Electron and serves it over the host protocol. Composed:
 * chat, stop, approvals and questions (the permission stack), the queue, background processes,
 * attachments (stored as sent, without image shrinking), the hosted model catalog and skills.
 * Left out: browser, screen, simulator, 3D model, media and video, MCP, local model servers,
 * pull request monitoring and Studio.
 */
export async function composeHeadlessHost(options: HeadlessHostOptions): Promise<HeadlessHost> {
  const { dataDirectory, homeDirectory, version, logger } = options;
  await ensurePrivateDirectory(dataDirectory);
  const hostId = await loadHostId(dataDirectory);

  const authListeners = new Set<(state: AuthState) => void>();
  const auth = createHeadlessHostAuth({
    dataDirectory,
    logger,
    userAgent: `b4m-host/${version}`,
    onStateChanged: state => {
      for (const listener of authListeners) listener(state);
    },
    ...options.auth,
  });
  await auth.initialize();

  const environment: HostEnvironment = {
    dataDirectory,
    homeDirectory,
    appName: 'Bike4Mind Host',
    platform: process.platform,
  };
  const protection = hostProtectedLocations(environment, logger);
  const { skills, permissions } = createHostPermissionStack({ environment, protection, auth, logger });
  const attachmentsDirectory = join(dataDirectory, 'attachments');
  const models = new ModelCatalog(
    {
      logger,
      getApiClient: () => auth.getApiClient(),
      getEnvironmentUrl: () => auth.getState().environment.url,
    },
    // No local model servers on this host: the hosted list is the whole catalog.
    { models: async () => [] }
  );

  const relay = new HostEventRelay(error => logger.warn(`HOST: a protocol listener failed: ${String(error)}`));
  const runtime = new HostRuntime({
    environment,
    events: relay.tee(noWindowSink),
    auth,
    logger,
    protection,
    collaborators: {
      attachments: new AttachmentStore(attachmentsDirectory, logger),
      models,
      permissions,
      skills,
      // Attachments sit inside the data directory but hold only what the user attached; see registerChat.
      shareableUnderProtected: [attachmentsDirectory],
    },
  });

  const control = createHostControl({
    hostId: async () => hostId,
    version,
    homeDirectory,
    capabilities: HEADLESS_HOST_CAPABILITIES,
    account: () => auth.status().account,
    startSignIn: () => auth.startSignIn(),
    onAuthStateChanged: listener => {
      authListeners.add(listener);
      return () => authListeners.delete(listener);
    },
  });
  const server = new HostServer(runtime, relay, logger, control);

  return {
    hostId,
    server,
    runtime,
    auth,
    dispose: () => {
      server.dispose();
      runtime.service.dispose();
      skills.dispose();
      permissions.dispose();
      auth.dispose();
    },
  };
}
