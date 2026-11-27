import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { HostInstallFailure, HostInstallProgress } from '@shared/hostConnection';
import { failureForExit, type ProcessSpec } from '../processTransport';
import type { HostArtifact } from './hostArtifact';
import { installBlocker, parseHostProbe, type HostProbe } from './hostProbe';
import { activateScript, INSTALL_PREFIX, installScript, PROBE_SCRIPT, STOP_DAEMON_SCRIPT } from './remoteScripts';
import { runRemoteScript, type RemoteScriptResult } from './remoteShell';

/** Thrown by HostInstaller; `failure` says what went wrong in terms the user can act on. */
export class HostInstallError extends Error {
  constructor(readonly failure: HostInstallFailure) {
    super(failure.detail);
    this.name = 'HostInstallError';
  }
}

export type HostInstallerTimeouts = {
  /** The probe, login shell included, in ms. */
  probeMs: number;
  /** One install, upload and lock wait included, in ms. */
  installMs: number;
  /** Stopping the daemon; the host program itself waits up to 15 s for it, in ms. */
  stopMs: number;
};

const DEFAULT_TIMEOUTS: HostInstallerTimeouts = { probeMs: 30_000, installMs: 10 * 60_000, stopMs: 30_000 };

export type HostInstallerOptions = {
  /** The process that runs a script on stdin on `alias`: `ssh <alias> -- sh -s`, see sshScriptSpec. */
  scriptSpec(alias: string): Promise<ProcessSpec>;
  newToken?(): string;
  timeouts?: Partial<HostInstallerTimeouts>;
  /** How long an install waits for another one's lock on the same machine, in seconds. */
  lockWaitSeconds?: number;
};

/** Phases install() reports; the caller reports preparing, probing, restarting and the outcome. */
export type InstallStepProgress = Extract<HostInstallProgress, { phase: 'uploading' | 'verifying' | 'activating' }>;

const BASE64_LINE = 76;
/** The codes an install script reports before failing for a reason of its own. */
const INSTALL_ERROR_KINDS: ReadonlyMap<string, HostInstallFailure['kind']> = new Map([
  ['busy', 'installBusy'],
  ['verify', 'installFailed'],
]);

const failure = (kind: HostInstallFailure['kind'], detail: string, stderrTail = ''): HostInstallFailure => ({
  kind,
  detail,
  stderrTail,
});

const describeEnd = (result: RemoteScriptResult): string =>
  result.timedOut
    ? 'timed out'
    : result.code === null
      ? `ended by signal ${result.signal ?? 'unknown'}`
      : `exited with code ${result.code}`;

/** ssh's own failures (exit 255), as the connection reports them; null for anything else. */
function sshFailure(result: RemoteScriptResult, label: string): HostInstallFailure | null {
  if (result.timedOut || result.code !== 255) return null;
  return failureForExit(result.code, result.signal, result.stderrTail, label);
}

/**
 * Probes, installs and stops the host program on a remote machine, each step one fixed script
 * over ssh (see remoteScripts.ts). Holds no state between calls and decides nothing about
 * running work: callers (HostProvisioner) serialize calls per host and choose when a daemon may
 * be stopped. A second Desktop installing to the same machine is kept out by the remote lock.
 */
export class HostInstaller {
  private readonly timeouts: HostInstallerTimeouts;
  private readonly newToken: () => string;

  constructor(private readonly options: HostInstallerOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.newToken = options.newToken ?? (() => randomBytes(16).toString('hex'));
  }

  /** What the machine has; rejects with HostInstallError when ssh fails or the answer cannot be read. */
  async probe(alias: string): Promise<HostProbe> {
    const result = await this.run(alias, PROBE_SCRIPT, { timeoutMs: this.timeouts.probeMs });
    const ssh = sshFailure(result, alias);
    if (ssh) throw new HostInstallError(ssh);
    const probe = result.code === 0 && !result.timedOut ? parseHostProbe(result.lines) : null;
    if (!probe) {
      throw new HostInstallError(
        failure(
          'probeFailed',
          `Could not read what ${alias} reported about itself (the probe ${describeEnd(result)})`,
          result.stderrTail
        )
      );
    }
    return probe;
  }

  /**
   * Installs `artifact` on the machine `probe` describes and, unless `activate` is false, makes it
   * the active version; with false it is left beside the active one for `activate`. Rejects with
   * HostInstallError for a machine the probe shows cannot run it, and for any step that fails;
   * whatever an interrupted run leaves behind, the next one clears.
   */
  async install(
    alias: string,
    artifact: HostArtifact,
    probe: HostProbe,
    onProgress: (progress: InstallStepProgress) => void = () => undefined,
    options: { activate?: boolean } = {}
  ): Promise<void> {
    const nodePath = this.nodePathFor(probe, alias);
    const tarball = await readFile(artifact.tarballPath);
    const encoded = tarball.toString('base64');
    const payloadLines: string[] = [];
    for (let offset = 0; offset < encoded.length; offset += BASE64_LINE) {
      payloadLines.push(encoded.slice(offset, offset + BASE64_LINE));
    }
    const script = installScript({
      version: artifact.version,
      sha256: artifact.sha256,
      nodePath,
      token: this.newToken(),
      payloadLines,
      lockWaitSeconds: this.options.lockWaitSeconds,
      activate: options.activate,
    });
    await this.runInstallStep(alias, script, onProgress, true);
  }

  /** Makes `version`, already installed by `install` with `activate: false`, the active version. */
  async activate(
    alias: string,
    version: string,
    probe: HostProbe,
    onProgress: (progress: InstallStepProgress) => void = () => undefined
  ): Promise<void> {
    const script = activateScript({
      version,
      nodePath: this.nodePathFor(probe, alias),
      token: this.newToken(),
      lockWaitSeconds: this.options.lockWaitSeconds,
    });
    await this.runInstallStep(alias, script, onProgress, false);
  }

  /** The probed node path; rejects for a machine the probe shows cannot run the host program. */
  private nodePathFor(probe: HostProbe, alias: string): string {
    const blocker = installBlocker(probe, alias);
    if (blocker) throw new HostInstallError(blocker);
    // installBlocker has checked the node path; the script builder checks it again.
    return probe.node?.path ?? '';
  }

  private async runInstallStep(
    alias: string,
    script: string,
    onProgress: (progress: InstallStepProgress) => void,
    reportUpload: boolean
  ): Promise<void> {
    const reported: { errorCode: string | null; finished: boolean } = { errorCode: null, finished: false };
    const phasePrefix = `${INSTALL_PREFIX} phase `;
    const errorPrefix = `${INSTALL_PREFIX} error `;
    const result = await this.run(alias, script, {
      timeoutMs: this.timeouts.installMs,
      onSent: reportUpload
        ? (sentBytes, totalBytes) => onProgress({ phase: 'uploading', sentBytes, totalBytes })
        : undefined,
      onLine: line => {
        if (line.startsWith(errorPrefix)) reported.errorCode = line.slice(errorPrefix.length);
        if (!line.startsWith(phasePrefix)) return;
        const phase = line.slice(phasePrefix.length);
        if (phase === 'verifying' || phase === 'activating') onProgress({ phase });
        if (phase === 'installed') reported.finished = true;
      },
    });
    if (result.code === 0 && reported.finished) return;
    const ssh = sshFailure(result, alias);
    if (ssh) throw new HostInstallError(ssh);
    const kind =
      (reported.errorCode === null ? undefined : INSTALL_ERROR_KINDS.get(reported.errorCode)) ?? 'installFailed';
    const detail =
      kind === 'installBusy'
        ? `Another install to ${alias} is still running. Try again in a few minutes.`
        : `Installing the host program on ${alias} failed (the install ${describeEnd(result)})`;
    throw new HostInstallError(failure(kind, detail, result.stderrTail));
  }

  /** Stops the machine's daemon, if one runs, and waits for it to exit. */
  async stopDaemon(alias: string): Promise<void> {
    const result = await this.run(alias, STOP_DAEMON_SCRIPT, { timeoutMs: this.timeouts.stopMs });
    if (result.code === 0 && !result.timedOut) return;
    const ssh = sshFailure(result, alias);
    throw new HostInstallError(
      ssh ??
        failure('installFailed', `Could not stop the host on ${alias} (it ${describeEnd(result)})`, result.stderrTail)
    );
  }

  private async run(
    alias: string,
    script: string,
    options: Parameters<typeof runRemoteScript>[2]
  ): Promise<RemoteScriptResult> {
    const spec = await this.options.scriptSpec(alias);
    try {
      return await runRemoteScript(spec, script, options);
    } catch (error) {
      throw new HostInstallError(
        failure(
          'sshFailed',
          `Could not start ${spec.command} to reach ${alias}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
}
