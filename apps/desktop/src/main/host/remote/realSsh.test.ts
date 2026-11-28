import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_PROTOCOL_VERSION, HostConnectError } from '@shared/hostProtocol';
import { hostArtifactProvider, scriptArtifactBuilder } from './install/hostArtifact';
import { HostInstaller } from './install/HostInstaller';
import { createProcessTransport } from './processTransport';
import { describeSshHost, sshScriptSpec, sshSpec } from './sshCommand';
import { listSshHosts } from './sshConfig';

/**
 * Against a real machine: set B4M_E2E_SSH_ALIAS to a Host alias of ~/.ssh/config that key or agent
 * authentication reaches without a prompt (`ssh localhost` works). Skipped otherwise, and in CI.
 */
const alias = process.env.B4M_E2E_SSH_ALIAS;
/**
 * Also set B4M_E2E_SSH_INSTALL=1 to install a fresh build of this checkout on that machine. It
 * replaces whatever ~/.b4m/host holds there and stops a daemon running from it, so point it at a
 * machine (or account) used for nothing else.
 */
const install = alias !== undefined && process.env.B4M_E2E_SSH_INSTALL === '1';

describe.skipIf(!alias)('a real ssh connection', () => {
  const target = alias ?? '';

  it('lists the alias from ~/.ssh/config and resolves it with ssh -G', async () => {
    expect((await listSshHosts()).aliases).toContain(target);
    const description = await describeSshHost(target);
    expect(description.alias).toBe(target);
    expect(description.hostname).not.toBe('');
    expect(description.port).toBeGreaterThan(0);
  });

  it('reaches b4m-host connect, or reports that it is not installed', async () => {
    const transport = await createProcessTransport(await sshSpec(target));
    try {
      const result = await transport.request('host/initialize', {
        clientId: 'real-ssh-e2e',
        clientName: 'real ssh e2e',
        clientVersion: '1',
        protocol: HOST_PROTOCOL_VERSION,
      });
      expect(result).toMatchObject({ hostId: expect.any(String) });
    } catch (error) {
      // ssh itself worked: the only acceptable failure is a machine without the host program.
      expect(error).toBeInstanceOf(HostConnectError);
      expect((error as HostConnectError).failure.kind).toBe('notInstalled');
    } finally {
      transport.close();
    }
  }, 60_000);
});

describe.skipIf(!install)('installing over a real ssh connection', () => {
  const target = alias ?? '';
  const version = `0.0.0-e2e.${Date.now()}`;
  const appPath = resolve(__dirname, '../../../..');

  it('installs this checkout, then connects to it', async () => {
    const artifact = await hostArtifactProvider(
      { packaged: false, appPath, build: scriptArtifactBuilder(appPath) },
      version
    )();
    const installer = new HostInstaller({ scriptSpec: sshScriptSpec });
    await installer.stopDaemon(target);
    const probe = await installer.probe(target);
    await installer.install(target, artifact, probe);

    expect(await installer.probe(target)).toMatchObject({
      launcher: { state: 'works', version },
      installedVersions: [version],
    });

    const transport = await createProcessTransport(await sshSpec(target));
    try {
      const result = await transport.request('host/initialize', {
        clientId: 'real-ssh-e2e',
        clientName: 'real ssh e2e',
        clientVersion: version,
        protocol: HOST_PROTOCOL_VERSION,
      });
      expect(result).toMatchObject({ hostVersion: version });
    } finally {
      transport.close();
      await installer.stopDaemon(target);
    }
  }, 300_000);
});
