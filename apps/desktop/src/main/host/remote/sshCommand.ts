import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { SshAliasDescription } from '@shared/hostConnection';
import { ensurePrivateDirectory } from '../../../host/auth/privateDirectory';
import { findOnPath, resolveUserPath } from '../../chat/tools/userPath';
import type { ProcessSpec } from './processTransport';

/**
 * The only user input that reaches an ssh command line. It must start with a letter or digit, so
 * it can never read as an option, and it is always passed after `--` as well.
 */
export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const MAX_ALIAS_LENGTH = 255;

export const isValidSshAlias = (alias: string): boolean =>
  alias.length <= MAX_ALIAS_LENGTH && SSH_ALIAS_PATTERN.test(alias);

export function requireSshAlias(alias: unknown): string {
  if (typeof alias !== 'string' || !isValidSshAlias(alias)) {
    throw new Error(`Not an SSH host alias: ${JSON.stringify(alias)}`);
  }
  return alias;
}

/** A fixed string: nothing from the host or the user is interpolated into a remote command. */
export const REMOTE_CONNECT_COMMAND = 'exec "$HOME/.b4m/host/bin/b4m-host" connect';

/** Runs the script that arrives on stdin; the installer's scripts are fixed text (install/remoteScripts.ts). */
export const REMOTE_SCRIPT_COMMAND = 'sh -s';

/**
 * Where Desktop's ssh multiplexing sockets live. Short on purpose: a unix socket path is limited
 * to about 104 bytes on macOS, and `%C` adds 40. Written with `~` so ssh expands it; ssh takes the
 * home directory from the password database, which is what `userInfo().homedir` reads too.
 */
const CONTROL_PATH = '~/.b4m/desktop/cm/%C';
export const controlDirectory = (): string => join(userInfo().homedir, '.b4m', 'desktop', 'cm');

/**
 * Options every Desktop ssh call passes. BatchMode stops ssh from ever prompting, so a host that
 * needs a password or an unknown host key fails with ssh's own message instead of hanging; host
 * keys are left to the user's known_hosts. The ControlMaster options let a window's connection
 * reuse the control connection's session instead of authenticating again; Windows OpenSSH has no
 * multiplexing, so there they are left out.
 */
export function sshOptions(platform: NodeJS.Platform = process.platform): string[] {
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15'];
  options.push('-o', 'ServerAliveCountMax=3');
  if (platform !== 'win32') {
    options.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlPersist=60');
  }
  return options;
}

/** The arguments of `ssh` that run `b4m-host connect` on `alias` with stdio as the protocol channel. */
export function sshConnectArgs(alias: string, platform: NodeJS.Platform = process.platform): string[] {
  return ['-T', ...sshOptions(platform), '--', requireSshAlias(alias), REMOTE_CONNECT_COMMAND];
}

/** The arguments of `ssh` that run a POSIX shell script, sent on stdin, on `alias`. */
export function sshScriptArgs(alias: string, platform: NodeJS.Platform = process.platform): string[] {
  return ['-T', ...sshOptions(platform), '--', requireSshAlias(alias), REMOTE_SCRIPT_COMMAND];
}

/** Thrown when there is no ssh on the user's PATH. */
export class SshNotFoundError extends Error {
  constructor() {
    super('No ssh program was found on PATH. Install OpenSSH to connect to other machines.');
    this.name = 'SshNotFoundError';
  }
}

export type SshEnvironment = { ssh: string; env: NodeJS.ProcessEnv };

/** The ssh program and the environment it runs with: the user's terminal PATH, so their ssh and agent setup apply. */
export async function resolveSshEnvironment(): Promise<SshEnvironment> {
  const path = await resolveUserPath();
  const ssh = await findOnPath('ssh', path);
  if (!ssh) throw new SshNotFoundError();
  return { ssh, env: { ...process.env, PATH: path } };
}

/** An ssh process with `args`. Creates the multiplexing directory ssh expects to exist. */
async function sshProcess(alias: string, args: string[], environment?: SshEnvironment): Promise<ProcessSpec> {
  const { ssh, env } = environment ?? (await resolveSshEnvironment());
  if (process.platform !== 'win32') await ensurePrivateDirectory(controlDirectory());
  return { command: ssh, args, env, label: alias };
}

/** The process that connects to `alias`'s host program. */
export async function sshSpec(alias: string, environment?: SshEnvironment): Promise<ProcessSpec> {
  return sshProcess(alias, sshConnectArgs(alias), environment);
}

/** The process that runs one of the installer's scripts on `alias`. */
export async function sshScriptSpec(alias: string, environment?: SshEnvironment): Promise<ProcessSpec> {
  return sshProcess(alias, sshScriptArgs(alias), environment);
}

/** Reads `ssh -G` output: one `keyword value` pair per line, keywords lower case. */
export function parseSshG(alias: string, output: string): SshAliasDescription {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (match && !values.has(match[1].toLowerCase())) values.set(match[1].toLowerCase(), match[2]);
  }
  const port = Number(values.get('port') ?? '22');
  return {
    alias,
    hostname: values.get('hostname') ?? alias,
    user: values.get('user') ?? '',
    port: Number.isInteger(port) && port > 0 ? port : 22,
  };
}

const DESCRIBE_TIMEOUT_MS = 10_000;

/** Resolves `alias` the way ssh would, without connecting. */
export async function describeSshHost(alias: string, environment?: SshEnvironment): Promise<SshAliasDescription> {
  const valid = requireSshAlias(alias);
  const { ssh, env } = environment ?? (await resolveSshEnvironment());
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      ssh,
      ['-G', '--', valid],
      { env, timeout: DESCRIBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(stdout);
      }
    );
  });
  return parseSshG(valid, output);
}
