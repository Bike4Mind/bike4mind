import { z } from 'zod';
import type { HostInstallFailure } from '@shared/hostConnection';
import { HOST_EXIT_CODES } from '../../../../host/headless/exitCodes';
import { MINIMUM_NODE_MAJOR } from '../../../../host/headless/hostBuild';
import { isHostVersion } from './hostArtifact';
import { isUsableNodePath, PROBE_PREFIX } from './remoteScripts';

const SUPPORTED_SYSTEMS: ReadonlySet<string> = new Set(['Darwin', 'Linux']);
/** Machines Node.js 24 publishes builds for, as `uname -m` names them. */
const SUPPORTED_MACHINES: ReadonlySet<string> = new Set(['x86_64', 'amd64', 'arm64', 'aarch64']);

/**
 * What PROBE_SCRIPT found on a machine. `launcher`: absent when the launcher is missing; otherwise the version the active build reports,
 * or the exit code it failed with. `daemon`: the version of the live daemon, `unknown` when no
 * Node.js was found to read its lock with.
 */
export type HostProbe = {
  os: string;
  arch: string;
  hasTar: boolean;
  node: { path: string; version: string; major: number | null } | null;
  installedVersions: string[];
  launcher: { state: 'absent' } | { state: 'works'; version: string } | { state: 'fails'; exitCode: number };
  daemon: { state: 'none' } | { state: 'running'; version: string } | { state: 'unknown' };
};

const probeLines = z.object({
  format: z.tuple([z.literal('1')]),
  os: z.tuple([z.string()]),
  arch: z.tuple([z.string()]),
  tar: z.tuple([z.enum(['yes', 'no'])]),
  node: z.tuple([z.string()]).optional(),
  nodeVersion: z.tuple([z.string()]).optional(),
  installed: z.array(z.string()).optional(),
  launcherExit: z.tuple([z.string().regex(/^[0-9]+$/)]).optional(),
  active: z.tuple([z.string()]).optional(),
  daemon: z.tuple([z.string()]).optional(),
  end: z.tuple([z.literal('1')]),
});

const nodeMajor = (version: string): number | null => {
  const match = /^v([0-9]+)\.[0-9]+\.[0-9]+/.exec(version);
  return match ? Number(match[1]) : null;
};

/**
 * Parses the probe's stdout. Only `b4m-probe` lines count, so a login shell's greeting cannot be
 * mistaken for an answer; anything else wrong (a missing key, a repeated one, no end line) makes
 * the whole answer unreadable rather than half read. Returns null then.
 */
export function parseHostProbe(lines: readonly string[]): HostProbe | null {
  const values: Record<string, string[]> = {};
  const prefix = `${PROBE_PREFIX} `;
  for (const line of lines) {
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);
    const space = rest.indexOf(' ');
    const key = space === -1 ? rest : rest.slice(0, space);
    const value = space === -1 ? '' : rest.slice(space + 1);
    (values[key] ??= []).push(value);
  }
  const parsed = probeLines.safeParse(values);
  if (!parsed.success) return null;
  const answer = parsed.data;

  const nodePath = answer.node?.[0];
  const nodeVersion = answer.nodeVersion?.[0] ?? '';
  const exitCode = answer.launcherExit ? Number(answer.launcherExit[0]) : null;
  const active = answer.active?.[0] ?? '';
  const daemon = answer.daemon?.[0];

  let launcher: HostProbe['launcher'] = { state: 'absent' };
  if (exitCode === 0 && isHostVersion(active)) launcher = { state: 'works', version: active };
  else if (exitCode !== null)
    launcher = { state: 'fails', exitCode: exitCode === 0 ? HOST_EXIT_CODES.failure : exitCode };

  return {
    os: answer.os[0],
    arch: answer.arch[0],
    hasTar: answer.tar[0] === 'yes',
    node: nodePath === undefined ? null : { path: nodePath, version: nodeVersion, major: nodeMajor(nodeVersion) },
    installedVersions: (answer.installed ?? []).filter(isHostVersion),
    launcher,
    daemon:
      daemon === undefined || daemon === ''
        ? { state: 'none' }
        : daemon === 'unknown' || !isHostVersion(daemon)
          ? { state: 'unknown' }
          : { state: 'running', version: daemon },
  };
}

/**
 * Why the host program cannot be installed on the probed machine, or null when it can: the
 * machine's system, a missing tar, and the Node.js its login shell finds.
 */
export function installBlocker(probe: HostProbe, label: string): HostInstallFailure | null {
  const failure = (kind: HostInstallFailure['kind'], detail: string): HostInstallFailure => ({
    kind,
    detail,
    stderrTail: '',
  });
  if (!SUPPORTED_SYSTEMS.has(probe.os) || !SUPPORTED_MACHINES.has(probe.arch)) {
    return failure(
      'unsupportedPlatform',
      `${label} runs ${probe.os} on ${probe.arch}; the Bike4Mind host program runs on macOS and Linux, on x86_64 or arm64`
    );
  }
  if (!probe.hasTar) return failure('unsupportedPlatform', `${label} has no tar command, which installing needs`);
  if (!probe.node) {
    return failure(
      'nodeMissing',
      `Node.js ${MINIMUM_NODE_MAJOR} or newer was not found on ${label}. Install it so that \`node\` is on the PATH of your login shell, then try again.`
    );
  }
  if (!isUsableNodePath(probe.node.path)) {
    return failure(
      'nodeMissing',
      `Node.js on ${label} is at ${JSON.stringify(probe.node.path)}, a path with characters the installer does not accept. Install Node.js at a plain path, then try again.`
    );
  }
  if (probe.node.major === null || probe.node.major < MINIMUM_NODE_MAJOR) {
    return failure(
      'nodeTooOld',
      `${label} has Node.js ${probe.node.version || 'of an unknown version'} at ${probe.node.path}; the host program needs ${MINIMUM_NODE_MAJOR} or newer. Update it, then try again.`
    );
  }
  return null;
}
