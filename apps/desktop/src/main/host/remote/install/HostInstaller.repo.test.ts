import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_EXIT_CODES } from '../../../../host/headless/exitCodes';
import type { ProcessSpec } from '../processTransport';
import type { HostArtifact } from './hostArtifact';
import { HostInstallError, HostInstaller, type InstallStepProgress } from './HostInstaller';
import { launcherScript } from './remoteScripts';

/*
 * Runs the real remote scripts with `sh -s` on this machine, standing in for `ssh <alias> -- sh -s`,
 * against a temporary HOME. PATH holds only the tools a remote machine is expected to have; Node.js
 * is found only through the login shell, the way a non-interactive ssh session often finds it.
 * A repo-lane test: it starts a few hundred processes and takes tens of seconds.
 */

const TOOLS = [
  'sh',
  'uname',
  'tar',
  'mkdir',
  'chmod',
  'ln',
  'readlink',
  'date',
  'mv',
  'rm',
  'sleep',
  'cat',
  'head',
  'tail',
];
const NODE_DIRECTORY = dirname(process.execPath);

let root: string;
let home: string;
let tools: string;
let loginShell: string;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

/** A login shell that adds `pathDirectory` to PATH and runs `-lc <command>`. */
function writeLoginShell(path: string, pathDirectory: string): void {
  writeExecutable(path, `#!/bin/sh\nPATH='${pathDirectory}':"$PATH"\nexport PATH\nexec /bin/sh -c "$2"\n`);
}

function scriptSpec(overrides: Partial<ProcessSpec> = {}): ProcessSpec {
  return {
    command: '/bin/sh',
    args: ['-s'],
    env: { HOME: home, PATH: tools, SHELL: loginShell },
    label: 'test-host',
    ...overrides,
  };
}

function installer(spec: ProcessSpec = scriptSpec(), lockWaitSeconds?: number): HostInstaller {
  return new HostInstaller({ scriptSpec: async () => spec, lockWaitSeconds, timeouts: { installMs: 60_000 } });
}

/** A packed build whose `version` command prints `reports`; `padding` bytes of noise make the upload long. */
function artifact(version: string, options: { reports?: string; padding?: number } = {}): HostArtifact {
  const source = join(root, `build-${version}-${randomBytes(4).toString('hex')}`);
  mkdirSync(source);
  writeFileSync(
    join(source, 'b4m-host.cjs'),
    [
      `const command = process.argv[2];`,
      `if (command === 'version') { console.log(${JSON.stringify(options.reports ?? version)}); process.exit(0); }`,
      `if (command === 'stop') { require('fs').writeFileSync(require('path').join(process.env.HOME, 'stopped'), ${JSON.stringify(version)}); process.exit(0); }`,
      `process.exit(1);`,
    ].join('\n')
  );
  if (options.padding) writeFileSync(join(source, 'padding.bin'), randomBytes(options.padding));
  const tarballPath = `${source}.tar.gz`;
  execFileSync('tar', ['-czf', tarballPath, '-C', source, '.']);
  const bytes = readFileSync(tarballPath);
  return { version, tarballPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const hostDirectory = () => join(home, '.b4m', 'host');
const installedVersions = () => readdirSync(join(hostDirectory(), 'versions')).sort();
const launcher = () => join(hostDirectory(), 'bin', 'b4m-host');
/** The lock is a symlink to a name that is not a file, so existsSync would always say no. */
const lockHeld = (): boolean => {
  try {
    lstatSync(join(hostDirectory(), 'install.lock'));
    return true;
  } catch {
    return false;
  }
};

/** Runs the launcher the way the remote `connect` would, with no node on PATH. */
function runLauncher(...args: string[]) {
  return spawnSync(launcher(), args, { env: { HOME: home, PATH: '/nonexistent' }, encoding: 'utf8' });
}

async function installFresh(
  target: HostInstaller,
  build: HostArtifact,
  onProgress?: (progress: InstallStepProgress) => void
) {
  const probe = await target.probe('test-host');
  await target.install('test-host', build, probe, onProgress);
}

async function failureOf(promise: Promise<unknown>): Promise<HostInstallError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  if (!(error instanceof HostInstallError)) throw new Error(`Expected a HostInstallError, got ${String(error)}`);
  return error;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'b4m-install-'));
  home = join(root, 'home');
  tools = join(root, 'tools');
  mkdirSync(home);
  mkdirSync(tools);
  for (const tool of TOOLS) {
    const found = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    symlinkSync(found, join(tools, tool));
  }
  loginShell = join(root, 'login-shell');
  writeLoginShell(loginShell, NODE_DIRECTORY);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('HostInstaller.probe', () => {
  it('finds Node.js through the login shell on a machine with nothing installed', async () => {
    const probe = await installer().probe('test-host');
    expect(['Darwin', 'Linux']).toContain(probe.os);
    expect(probe.hasTar).toBe(true);
    expect(probe.node?.path).toBe(process.execPath);
    expect(probe.node?.major).toBeGreaterThanOrEqual(24);
    expect(probe.installedVersions).toEqual([]);
    expect(probe.launcher).toEqual({ state: 'absent' });
    expect(probe.daemon).toEqual({ state: 'none' });
  });

  it('reports unreadable output as probeFailed with the stderr tail', async () => {
    const spec = scriptSpec({ command: '/bin/sh', args: ['-c', 'cat >/dev/null; echo "Welcome!"; echo oops >&2'] });
    const error = await failureOf(installer(spec).probe('test-host'));
    expect(error.failure.kind).toBe('probeFailed');
    expect(error.failure.stderrTail).toContain('oops');
  });

  it('reports a probe cut short as probeFailed', async () => {
    const spec = scriptSpec({ command: '/bin/sh', args: ['-c', 'head -c 120 | /bin/sh -s'] });
    expect((await failureOf(installer(spec).probe('test-host'))).failure.kind).toBe('probeFailed');
  });

  it("reports ssh's own exit as sshFailed", async () => {
    const spec = scriptSpec({
      command: '/bin/sh',
      args: ['-c', 'cat >/dev/null; echo "Could not resolve hostname" >&2; exit 255'],
    });
    const error = await failureOf(installer(spec).probe('test-host'));
    expect(error.failure).toMatchObject({ kind: 'sshFailed', detail: 'Could not resolve hostname' });
  });

  it('reports a spawn failure as sshFailed', async () => {
    const spec = scriptSpec({ command: join(root, 'no-such-ssh') });
    expect((await failureOf(installer(spec).probe('test-host'))).failure.kind).toBe('sshFailed');
  });
});

describe('HostInstaller.install', () => {
  it('installs a launcher that runs the build with no node on PATH', async () => {
    const progress: InstallStepProgress[] = [];
    await installFresh(installer(), artifact('1.0.0'), step => progress.push(step));

    expect(installedVersions()).toEqual(['1.0.0']);
    const run = runLauncher('version');
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe('1.0.0');
    expect(statSync(hostDirectory()).mode & 0o777).toBe(0o700);
    expect(lockHeld()).toBe(false);

    const phases = progress.map(step => step.phase);
    expect(phases[0]).toBe('uploading');
    expect(phases.slice(-2)).toEqual(['verifying', 'activating']);
    const last = progress.filter(step => step.phase === 'uploading').at(-1);
    expect(last).toMatchObject({ phase: 'uploading' });
    if (last?.phase === 'uploading') expect(last.sentBytes).toBe(last.totalBytes);

    const probe = await installer().probe('test-host');
    expect(probe.launcher).toEqual({ state: 'works', version: '1.0.0' });
    expect(probe.installedVersions).toEqual(['1.0.0']);
  });

  it('stages a version beside the active one and switches to it on activate', async () => {
    const target = installer();
    await installFresh(target, artifact('1.0.0'));
    const progress: InstallStepProgress[] = [];
    const probe = await target.probe('test-host');
    await target.install('test-host', artifact('2.0.0'), probe, step => progress.push(step), { activate: false });

    expect(installedVersions()).toEqual(['1.0.0', '2.0.0']);
    expect(runLauncher('version').stdout.trim()).toBe('1.0.0');
    expect(progress.map(step => step.phase)).not.toContain('activating');

    const activated: InstallStepProgress[] = [];
    await target.activate('test-host', '2.0.0', probe, step => activated.push(step));
    expect(runLauncher('version').stdout.trim()).toBe('2.0.0');
    expect(installedVersions()).toEqual(['2.0.0']);
    expect(activated.map(step => step.phase)).toEqual(['activating']);
    expect(lockHeld()).toBe(false);
  });

  it('refuses to activate a version that is not installed', async () => {
    const target = installer();
    await installFresh(target, artifact('1.0.0'));
    const probe = await target.probe('test-host');
    expect((await failureOf(target.activate('test-host', '3.0.0', probe))).failure.kind).toBe('installFailed');
    expect(runLauncher('version').stdout.trim()).toBe('1.0.0');
  });

  it('is idempotent and clears what an earlier interrupted install left', async () => {
    const build = artifact('1.0.0');
    await installFresh(installer(), build);
    mkdirSync(join(hostDirectory(), 'versions', '2.0.0.tmp'));
    writeFileSync(join(hostDirectory(), 'versions', '2.0.0.tmp.tar'), 'partial');
    writeFileSync(join(hostDirectory(), 'bin', 'b4m-host.0123456789abcdef.tmp'), 'partial');

    await installFresh(installer(), build);

    expect(installedVersions()).toEqual(['1.0.0']);
    expect(readdirSync(join(hostDirectory(), 'bin'))).toEqual(['b4m-host']);
    expect(runLauncher('version').stdout.trim()).toBe('1.0.0');
  });

  it('leaves no half install and keeps the active version when the upload is cut short', async () => {
    await installFresh(installer(), artifact('1.0.0'));
    const next = artifact('2.0.0', { padding: 64 * 1024 });
    const truncating = installer(scriptSpec({ command: '/bin/sh', args: ['-c', 'head -c 20000 | /bin/sh -s'] }));

    const error = await failureOf(truncating.install('test-host', next, await truncating.probe('test-host')));

    expect(error.failure.kind).toBe('installFailed');
    expect(installedVersions()).toEqual(['1.0.0']);
    expect(lockHeld()).toBe(false);
    expect(runLauncher('version').stdout.trim()).toBe('1.0.0');

    await installFresh(installer(), next);
    expect(installedVersions()).toEqual(['2.0.0']);
  });

  it('refuses an upload that does not match its sha256', async () => {
    const build = { ...artifact('1.0.0'), sha256: '0'.repeat(64) };
    const error = await failureOf(installFresh(installer(), build));
    expect(error.failure.kind).toBe('installFailed');
    expect(error.failure.stderrTail).toContain('damaged');
    expect(installedVersions()).toEqual([]);
    expect(existsSync(launcher())).toBe(false);
  });

  it('refuses a build that reports another version', async () => {
    const error = await failureOf(installFresh(installer(), artifact('1.0.0', { reports: '0.9.0' })));
    expect(error.failure.kind).toBe('installFailed');
    expect(error.failure.stderrTail).toContain("reports version '0.9.0'");
    expect(installedVersions()).toEqual([]);
    expect(existsSync(launcher())).toBe(false);
  });

  it("prunes old versions but keeps the running daemon's", async () => {
    await installFresh(installer(), artifact('1.0.0'));
    writeFileSync(
      join(hostDirectory(), 'host.lock'),
      JSON.stringify({ pid: process.pid, version: '1.0.0', startedAt: 0 })
    );

    await installFresh(installer(), artifact('2.0.0'));
    expect(installedVersions()).toEqual(['1.0.0', '2.0.0']);
    expect((await installer().probe('test-host')).daemon).toEqual({ state: 'running', version: '1.0.0' });

    await installFresh(installer(), artifact('3.0.0'));
    expect(installedVersions()).toEqual(['1.0.0', '3.0.0']);
    expect(runLauncher('version').stdout.trim()).toBe('3.0.0');
  });

  it('prunes a version whose daemon has exited', async () => {
    await installFresh(installer(), artifact('1.0.0'));
    const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    const pid = Number(exited.stdout.trim());
    writeFileSync(join(hostDirectory(), 'host.lock'), JSON.stringify({ pid, version: '1.0.0', startedAt: 0 }));

    await installFresh(installer(), artifact('2.0.0'));
    expect(installedVersions()).toEqual(['2.0.0']);
  });

  it('serializes concurrent installs to one machine through the remote lock', async () => {
    const first = installer();
    const second = installer();
    const [probeA, probeB] = await Promise.all([first.probe('test-host'), second.probe('test-host')]);
    const one = artifact('1.0.0', { padding: 256 * 1024 });
    const two = artifact('2.0.0', { padding: 256 * 1024 });

    await Promise.all([first.install('test-host', one, probeA), second.install('test-host', two, probeB)]);

    const active = runLauncher('version').stdout.trim();
    expect(['1.0.0', '2.0.0']).toContain(active);
    expect(installedVersions()).toEqual([active]);
    expect(readdirSync(join(hostDirectory(), 'bin'))).toEqual(['b4m-host']);
    expect(lockHeld()).toBe(false);
  });

  it('gives up with installBusy while another install holds a fresh lock', async () => {
    mkdirSync(hostDirectory(), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    symlinkSync(`${'ab'.repeat(16)}-${now}`, join(hostDirectory(), 'install.lock'));

    const error = await failureOf(installFresh(installer(scriptSpec(), 1), artifact('1.0.0')));

    expect(error.failure.kind).toBe('installBusy');
    // The other install's lock is its own to release.
    expect(lockHeld()).toBe(true);
  });

  it('takes over a lock abandoned long ago', async () => {
    mkdirSync(hostDirectory(), { recursive: true });
    symlinkSync(`${'ab'.repeat(16)}-1000`, join(hostDirectory(), 'install.lock'));

    await installFresh(installer(scriptSpec(), 1), artifact('1.0.0'));

    expect(runLauncher('version').stdout.trim()).toBe('1.0.0');
    expect(lockHeld()).toBe(false);
  });

  it('sweeps abandoned locks another install left aside, once they are older than the stale age', async () => {
    mkdirSync(hostDirectory(), { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const old = join(hostDirectory(), `install.lock.${'cd'.repeat(8)}`);
    const recent = join(hostDirectory(), `install.lock.${'ef'.repeat(8)}`);
    symlinkSync(`${'ab'.repeat(16)}-1000`, old);
    symlinkSync(`${'ab'.repeat(16)}-${now}`, recent);

    await installFresh(installer(), artifact('1.0.0'));

    const names = readdirSync(hostDirectory()).filter(name => name.startsWith('install.lock'));
    expect(names).toEqual([`install.lock.${'ef'.repeat(8)}`]);
  });
});

describe('HostInstaller refuses machines it cannot install on', () => {
  it('names an unsupported system', async () => {
    rmSync(join(tools, 'uname'));
    writeExecutable(join(tools, 'uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo FreeBSD; else echo x86_64; fi\n');
    const target = installer();
    const probe = await target.probe('test-host');
    const error = await failureOf(target.install('test-host', artifact('1.0.0'), probe));
    expect(error.failure.kind).toBe('unsupportedPlatform');
    expect(existsSync(hostDirectory())).toBe(false);
  });

  it('names a missing Node.js', async () => {
    writeLoginShell(loginShell, join(root, 'empty'));
    const target = installer();
    const probe = await target.probe('test-host');
    expect(probe.node).toBeNull();
    expect((await failureOf(target.install('test-host', artifact('1.0.0'), probe))).failure.kind).toBe('nodeMissing');
  });

  it('names a Node.js older than the host program needs', async () => {
    const oldNode = join(root, 'old-node');
    mkdirSync(oldNode);
    writeExecutable(join(oldNode, 'node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo "$0"; else echo v20.11.1; fi\n');
    writeLoginShell(loginShell, oldNode);
    const target = installer();
    const probe = await target.probe('test-host');
    expect(probe.node).toMatchObject({ version: 'v20.11.1', major: 20 });
    expect((await failureOf(target.install('test-host', artifact('1.0.0'), probe))).failure.kind).toBe('nodeTooOld');
  });
});

describe('HostInstaller.stopDaemon', () => {
  it('stops through the active launcher', async () => {
    await installFresh(installer(), artifact('1.0.0'));
    await installer().stopDaemon('test-host');
    expect(readFileSync(join(home, 'stopped'), 'utf8')).toBe('1.0.0');
  });

  it('does nothing where nothing is installed', async () => {
    await expect(installer().stopDaemon('test-host')).resolves.toBeUndefined();
  });
});

describe('launcherScript', () => {
  it('exits with nodeMissing once Node.js is gone from the path it was written with', () => {
    const path = join(root, 'launcher');
    writeExecutable(path, launcherScript('1.0.0', join(root, 'gone', 'node')));
    const run = spawnSync(path, ['version'], { env: { HOME: home, PATH: '/nonexistent' }, encoding: 'utf8' });
    expect(run.status).toBe(HOST_EXIT_CODES.nodeMissing);
    expect(run.stderr).toContain('no longer at');
  });
});
