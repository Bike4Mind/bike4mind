import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { FetchLike } from '../types';
import { createServerFetch, ServerTransportError } from './serverFetch';

/** Where an SSH server's Ollama is reached: loopback on the far end of the stdio forward. */
export const SSH_OLLAMA_URL = 'http://127.0.0.1:11434';
const FORWARD_TARGET = '127.0.0.1:11434';
export const SSH_CONNECT_TIMEOUT_S = 15;
/** A probe over SSH waits for the connect timeout plus Ollama's answer. */
export const SSH_PROBE_TIMEOUT_MS = (SSH_CONNECT_TIMEOUT_S + 5) * 1000;

// An optional user, then a host name or a Host alias. No option, no spaces, no shell or ssh_config syntax.
const DESTINATION = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;

/** Why `input` is not a usable SSH destination (`user@host` or a Host alias); null when it is. */
export function sshDestinationProblem(input: string): string | null {
  const value = input.trim();
  if (!value) return 'Enter an SSH destination such as user@host, or a Host alias from your ssh config.';
  if (value.startsWith('-')) return 'An SSH destination cannot start with "-".';
  if (!DESTINATION.test(value)) {
    return 'Enter an SSH destination such as user@host, or a Host alias, using only letters, digits, dots, dashes and underscores.';
  }
  return null;
}

export function parseSshDestination(input: string): string | null {
  return sshDestinationProblem(input) === null ? input.trim() : null;
}

/** A short default name: the host without its user or domain. */
export function suggestSshName(destination: string): string {
  const host = destination.slice(destination.indexOf('@') + 1);
  if (/^[\d.]+$/.test(host)) return host;
  return host.split('.')[0] || host;
}

// What ssh, a ProxyCommand and an agent need. DISPLAY and SSH_ASKPASS stay out so nothing can prompt.
const POSIX_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
  'KRB5CCNAME',
]);
const WINDOWS_ENV = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'TEMP',
  'TMP',
  'SSH_AUTH_SOCK',
]);

/** The ssh child's environment: an allowlist, never the app's own environment with its keys and tokens. */
export function sshChildEnv(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const windows = platform === 'win32';
  const allowed = windows ? WINDOWS_ENV : POSIX_ENV;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && allowed.has(windows ? key.toUpperCase() : key)) out[key] = value;
  }
  return out;
}

/**
 * Arguments for one stdio forward to the far end's Ollama. Nothing in them can prompt or run a command.
 * Without our own `controlPath` the forward may reuse the user's master but never becomes one: a master
 * started here would end the user's sessions when it exits, or persist with this stripped environment.
 */
export function sshArgs(
  destination: string,
  controlPath: string | null = null,
  platform: NodeJS.Platform = process.platform
): string[] {
  const option = (value: string) => ['-o', value];
  return [
    ...option('BatchMode=yes'),
    ...option(`ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`),
    ...option('RemoteCommand=none'),
    ...option('StrictHostKeyChecking=yes'),
    ...option('ForwardAgent=no'),
    ...option('ForwardX11=no'),
    // -W implies this, but a config can override it; a LocalForward must never ride on our master.
    ...option('ClearAllForwardings=yes'),
    ...option('PermitLocalCommand=no'),
    ...option('ServerAliveInterval=15'),
    ...option('ServerAliveCountMax=3'),
    ...(controlPath
      ? [...option('ControlMaster=auto'), ...option(`ControlPath=${controlPath}`), ...option('ControlPersist=120')]
      : [...option('ControlMaster=no'), ...(platform === 'win32' ? option('ControlPath=none') : [])]),
    '-W',
    FORWARD_TARGET,
    '--',
    destination,
  ];
}

// sun_path sizes, counting the terminating NUL. Windows OpenSSH has no connection sharing.
const SOCKET_PATH_LIMIT: Partial<Record<NodeJS.Platform, number>> = {
  linux: 108,
  darwin: 104,
  freebsd: 104,
  openbsd: 104,
};
// %C expands to 40 hex characters, and the master first binds that name plus a 17-character suffix.
const CONTROL_NAME_CHARS = 40 + 17;

/** The shared-connection socket under `~/.ssh/b4m`, or null where it would not fit the OS limit. */
export function sharedControlPath(home: string, platform: NodeJS.Platform): { dir: string; option: string } | null {
  const limit = SOCKET_PATH_LIMIT[platform];
  if (!limit) return null;
  const dir = path.posix.join(home, '.ssh', 'b4m');
  if (Buffer.byteLength(dir) + 1 + CONTROL_NAME_CHARS >= limit) return null;
  return { dir, option: '~/.ssh/b4m/%C' };
}

/** Whether `ssh -G` output shows the user's own ControlPath, which then decides sharing instead of ours. */
export function setsControlPath(effectiveConfig: string): boolean {
  return effectiveConfig.split('\n').some(line => {
    const [key, ...rest] = line.trim().split(/\s+/);
    return key?.toLowerCase() === 'controlpath' && rest.join(' ').toLowerCase() !== 'none';
  });
}

/** Needs the user to act: trust a host key, fix a login, or change the server. Shown as Refused. */
export class SshRefusedError extends ServerTransportError {
  constructor(message: string) {
    super(message);
    this.name = 'SshRefusedError';
  }
}

/** The connection did not come up or dropped; a later check may succeed. Shown as Unreachable. */
export class SshConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshConnectionError';
  }
}

const NOISE = [/^Warning: Permanently added/i, /^Pseudo-terminal will not be allocated/i];

function lastLine(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n/)
    .map(line => line.replace(/[^\x20-\x7e]/g, '').trim())
    .filter(line => line && !NOISE.some(pattern => pattern.test(line)));
  const line = lines.at(-1);
  return line ? line.slice(0, 300) : null;
}

/** What ssh's stderr and exit code mean, in words that say what to do. */
export function describeSshFailure(stderr: string, code: number | null, destination: string, app = 'Desktop'): Error {
  const terminal = `\`ssh ${destination}\``;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return new SshRefusedError(
      `The host key of ${destination} has changed since this computer last connected. Check why, then connect once from a terminal with ${terminal} to trust the new key.`
    );
  }
  if (/Host key verification failed|host key is known|No .* host key is known/i.test(stderr)) {
    return new SshRefusedError(`Connect once from a terminal with ${terminal} to trust this server's host key.`);
  }
  if (/open failed: connect failed/i.test(stderr)) {
    return new SshConnectionError(
      `SSH to ${destination} works, but nothing answers at ${FORWARD_TARGET} there. Start Ollama on that machine.`
    );
  }
  if (/administratively prohibited/i.test(stderr)) {
    return new SshRefusedError(
      `${destination} does not allow SSH port forwarding, which ${app} needs to reach Ollama there. Set AllowTcpForwarding to yes or local in its sshd_config.`
    );
  }
  if (/: Permission denied \(|Too many authentication failures|no more authentication methods/i.test(stderr)) {
    return new SshRefusedError(
      `${destination} refused the SSH login. Check that ${terminal} works in a terminal. ${app} cannot ask for a password or passphrase, so load a key that has one into ssh-agent with ssh-add.`
    );
  }
  // Over a shared connection ssh reports every refused forward the same way, so name both causes.
  if (/Session open refused by peer|stdio forwarding failed/i.test(stderr)) {
    return new SshConnectionError(
      `SSH to ${destination} works, but it refused the forward to ${FORWARD_TARGET}. Check that Ollama is running there and that its sshd_config allows TCP forwarding (AllowTcpForwarding).`
    );
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return new SshConnectionError(`Could not find ${destination}. Check the name, or its HostName in your ssh config.`);
  }
  const line = lastLine(stderr);
  if (line) return new SshConnectionError(`ssh ${destination} failed: ${line}`);
  return new SshConnectionError(`ssh ${destination} stopped (exit code ${code ?? 'unknown'}).`);
}

type Spawn = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; windowsHide: boolean; detached?: boolean }
) => ChildProcess;

export interface SshDeps {
  /** The ssh binary; defaults to `ssh` on PATH. */
  command?: string;
  spawn?: Spawn;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The home ssh expands `~` to, which is the account's, not $HOME. */
  home?: string;
  makeDir?(dir: string): Promise<void>;
}

const STDERR_LIMIT = 8 * 1024;
const CONFIG_LIMIT = 256 * 1024;
const CONFIG_TIMEOUT_MS = 5_000;

const defaultSpawn: Spawn = (command, args, options) =>
  spawnChild(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

// chmod as well: mkdir leaves the mode of an existing directory alone.
async function makePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

/** One `ssh -W` process as the socket of one HTTP request. */
class SshForward extends Duplex {
  private stderr = '';
  private idleMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: ChildProcess,
    describe: (stderr: string, code: number | null) => Error,
    spawnFailed: (error: NodeJS.ErrnoException) => Error
  ) {
    super();
    const { stdout, stderr, stdin } = child;
    stdout?.on('data', (chunk: Buffer) => {
      this.touch();
      if (!this.push(chunk)) stdout.pause();
    });
    // The verdict is at the end, after any debug output from a LogLevel in the user's config.
    stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });
    stdout?.on('error', error => this.destroy(error));
    stderr?.on('error', () => undefined);
    // EPIPE when ssh exits first; the close handler reports why it exited.
    stdin?.on('error', () => undefined);
    child.once('error', error => this.destroy(spawnFailed(error)));
    child.once('close', code => {
      if (this.destroyed) return;
      if (code === 0) this.push(null);
      else this.destroy(describe(this.stderr, code));
    });
  }

  override _read(): void {
    this.child.stdout?.resume();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.touch();
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) return callback();
    stdin.write(chunk, () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin?.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.idleTimer);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    callback(error);
  }

  // The parts of net.Socket that Node's http client calls.
  setTimeout(ms: number, callback?: () => void): this {
    this.idleMs = ms;
    if (callback) {
      if (ms === 0) this.removeListener('timeout', callback);
      else this.once('timeout', callback);
    }
    this.touch();
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  destroySoon(): void {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once('finish', () => this.destroy());
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.idleMs > 0 && !this.destroyed) {
      this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMs);
      this.idleTimer.unref?.();
    }
  }
}

export interface SshEndpoint {
  /** Validated with `parseSshDestination`. */
  destination: string;
  /** Shown in errors. */
  label: string;
  app?: string;
}

/**
 * Fetch for an Ollama reached over SSH. Each request runs the system ssh with a stdio forward to the far
 * end's 127.0.0.1:11434, non-interactively; when the user's ssh config sets no ControlPath, requests share
 * one connection through a short socket under ~/.ssh/b4m. Requests carry no credentials: ssh does the login.
 */
export function createSshFetch(endpoint: SshEndpoint, deps: SshDeps = {}): FetchLike {
  const destination = parseSshDestination(endpoint.destination);
  const app = endpoint.app ?? 'Desktop';
  const command = deps.command ?? 'ssh';
  const spawn = deps.spawn ?? defaultSpawn;
  const platform = deps.platform ?? process.platform;
  const env = sshChildEnv(deps.env, platform);
  let args: string[] = destination ? sshArgs(destination, null, platform) : [];
  let prepared: Promise<void> | null = null;

  const spawnFailed = (error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT'
      ? new SshRefusedError(`${app} could not find the ssh command. Install the OpenSSH client.`)
      : new SshConnectionError(`${app} could not start ssh (${error.code ?? error.message}).`);

  const prepare = async () => {
    if (!destination) return;
    const shared = sharedControlPath(deps.home ?? accountHome(), platform);
    if (!shared) return;
    const config = await effectiveConfig(destination);
    if (config === null || setsControlPath(config)) return;
    try {
      await (deps.makeDir ?? makePrivateDir)(shared.dir);
    } catch {
      return;
    }
    args = sshArgs(destination, shared.option, platform);
  };

  // `ssh -G` prints the configuration ssh would use, without connecting.
  const effectiveConfig = (target: string) =>
    new Promise<string | null>(resolve => {
      let child: ChildProcess;
      try {
        child = spawn(command, ['-G', '--', target], { env, windowsHide: true });
      } catch {
        return resolve(null);
      }
      let out = '';
      const timer = setTimeout(() => child.kill(), CONFIG_TIMEOUT_MS);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (out.length < CONFIG_LIMIT) out += chunk.toString('utf8');
      });
      child.stderr?.resume();
      child.stdout?.on('error', () => undefined);
      child.stderr?.on('error', () => undefined);
      child.once('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once('close', code => {
        clearTimeout(timer);
        resolve(code === 0 ? out : null);
      });
    });

  const inner = createServerFetch({
    origin: new URL(SSH_OLLAMA_URL).origin,
    label: endpoint.label,
    app,
    credentialHeaders: () => null,
    connect: () => {
      let child: ChildProcess;
      try {
        // Its own session, so neither ssh nor a ProxyJump hop has a terminal to prompt on.
        child = spawn(command, args, { env, windowsHide: true, detached: platform !== 'win32' });
      } catch (error) {
        const forward = new Duplex({ read() {} });
        process.nextTick(() => forward.destroy(spawnFailed(error as NodeJS.ErrnoException)));
        return forward;
      }
      return new SshForward(
        child,
        (stderr, code) => describeSshFailure(stderr, code, destination as string, app),
        spawnFailed
      );
    },
  });

  return async (input, init) => {
    if (!destination) throw new SshRefusedError(sshDestinationProblem(endpoint.destination) as string);
    await (prepared ??= prepare().catch(() => undefined));
    return inner(input, init);
  };
}
