import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ipcMain } from 'electron';
import { z } from 'zod';
import type {
  HostInstallProgressEvent,
  HostInstallResult,
  SshAliasDescription,
  SshAliasEntry,
} from '@shared/hostConnection';
import { IPC_CHANNELS } from '@shared/ipc';
import { appWindows } from '../../windows';
import type { ConnectionManager } from '../ConnectionManager';
import { DEFAULT_HOST_LINK_TUNING } from '../HostLink';
import { hostArtifactProvider, type HostArtifactSource } from './install/hostArtifact';
import { HostInstaller } from './install/HostInstaller';
import { HostProvisioner, queryRunningWork } from './install/HostProvisioner';
import { createProcessTransport } from './processTransport';
import { listSshHosts } from './sshConfig';
import { describeSshHost, requireSshAlias, sshScriptSpec, sshSpec } from './sshCommand';
import { SshHostDirectory } from './SshHostDirectory';
import { SSH_HOSTS_FILE_NAME, sshHostsFile } from './sshHostsFile';

export type SshHostsOptions = {
  /** userData; `hosts.json` lives here. */
  dataDirectory: string;
  /** This Desktop's version: the host program version it installs and connects to. */
  version: string;
  /** Where this Desktop's copy of the host program comes from. */
  artifactSource: HostArtifactSource;
  log(message: string): void;
};

const hostIdInput = z.string().min(1);
const updateOptionsInput = z.object({ force: z.boolean() }).strict();

function broadcastInstallProgress(event: HostInstallProgressEvent): void {
  for (const window of appWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(IPC_CHANNELS.hostInstallProgress, event);
  }
}

/**
 * Registers the remote hosts saved in `hosts.json` with the ConnectionManager, each connecting
 * through `ssh <alias> b4m-host connect` once HostProvisioner has checked the machine, and serves
 * the bridge's SSH, install and update calls. Their arguments arrive from a renderer, so each is
 * validated here before it reaches anything else.
 */
export function registerSshHosts(manager: ConnectionManager, options: SshHostsOptions): SshHostDirectory {
  const { log, version } = options;
  const openTransport = async (alias: string) =>
    createProcessTransport(await sshSpec(alias), { onProtocolError: detail => log(`HOST: ${detail}`) });
  const client = { clientId: randomUUID(), clientName: 'Bike4Mind Desktop installer', clientVersion: version };
  const provisioner: HostProvisioner = new HostProvisioner({
    installer: new HostInstaller({ scriptSpec: sshScriptSpec }),
    artifact: hostArtifactProvider(options.artifactSource, version),
    version,
    hosts: {
      installTarget: hostId => directory.installTarget(hostId),
      setInstallConsent: (hostId, consent) => directory.setInstallConsent(hostId, consent),
    },
    reconnect: hostId => manager.connect(hostId),
    runningWork: alias =>
      queryRunningWork(() => openTransport(alias), client, DEFAULT_HOST_LINK_TUNING.requestTimeoutMs, log),
    onProgress: broadcastInstallProgress,
    log,
  });
  const directory: SshHostDirectory = new SshHostDirectory({
    manager,
    store: sshHostsFile(join(options.dataDirectory, SSH_HOSTS_FILE_NAME), log),
    openTransport,
    listConfigHosts: () => listSshHosts(),
    prepareConnection: (id, alias) => provisioner.beforeConnect(id, alias),
    log,
  });
  const loaded = directory.load().catch((error: unknown) => {
    log(`HOST: could not load the saved SSH hosts: ${error instanceof Error ? error.message : String(error)}`);
  });

  ipcMain.handle(IPC_CHANNELS.hostSshAliases, async (): Promise<SshAliasEntry[]> => {
    await loaded;
    return directory.aliasEntries();
  });
  ipcMain.handle(IPC_CHANNELS.hostSshDescribe, (_event, alias: unknown): Promise<SshAliasDescription> =>
    describeSshHost(requireSshAlias(alias))
  );
  ipcMain.handle(IPC_CHANNELS.hostSshAdd, async (_event, alias: unknown): Promise<string> => {
    const valid = requireSshAlias(alias);
    await loaded;
    return (await directory.add(valid)).id;
  });
  ipcMain.handle(IPC_CHANNELS.hostInstall, async (_event, hostId: unknown): Promise<HostInstallResult> => {
    const valid = hostIdInput.parse(hostId);
    await loaded;
    return provisioner.install(valid);
  });
  ipcMain.handle(
    IPC_CHANNELS.hostUpdate,
    async (_event, hostId: unknown, updateOptions: unknown): Promise<HostInstallResult> => {
      const valid = hostIdInput.parse(hostId);
      const parsed = updateOptionsInput.parse(updateOptions);
      await loaded;
      return provisioner.update(valid, parsed);
    }
  );
  return directory;
}
