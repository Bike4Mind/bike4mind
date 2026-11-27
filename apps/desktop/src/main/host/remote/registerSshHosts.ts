import { join } from 'node:path';
import { ipcMain } from 'electron';
import type { SshAliasDescription, SshAliasEntry } from '@shared/hostConnection';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ConnectionManager } from '../ConnectionManager';
import { createProcessTransport } from './processTransport';
import { listSshHosts } from './sshConfig';
import { describeSshHost, requireSshAlias, sshSpec } from './sshCommand';
import { SshHostDirectory } from './SshHostDirectory';
import { SSH_HOSTS_FILE_NAME, sshHostsFile } from './sshHostsFile';

export type SshHostsOptions = {
  /** userData; `hosts.json` lives here. */
  dataDirectory: string;
  log(message: string): void;
};

/**
 * Registers the remote hosts saved in `hosts.json` with the ConnectionManager, each connecting
 * through `ssh <alias> b4m-host connect`, and serves the bridge's SSH calls. Aliases arrive from a
 * renderer, so each is validated here before it reaches anything else.
 */
export function registerSshHosts(manager: ConnectionManager, options: SshHostsOptions): SshHostDirectory {
  const { log } = options;
  const directory = new SshHostDirectory({
    manager,
    store: sshHostsFile(join(options.dataDirectory, SSH_HOSTS_FILE_NAME), log),
    openTransport: async alias =>
      createProcessTransport(await sshSpec(alias), { onProtocolError: detail => log(`HOST: ${detail}`) }),
    listConfigHosts: () => listSshHosts(),
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
  return directory;
}
