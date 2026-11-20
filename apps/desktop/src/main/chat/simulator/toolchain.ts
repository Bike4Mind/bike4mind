import { execFile } from 'node:child_process';
import { resolveUserPath } from '../tools/userPath';

export const AXE_INSTALL_COMMAND = 'brew install cameroncooke/axe/axe';

/**
 * A problem only the user can fix: the message names the cause and the exact fix, and tells the
 * model not to retry, since calling again changes nothing until the user acts.
 */
export class SimulatorSetupError extends Error {
  constructor(
    readonly problem: string,
    readonly fix: string
  ) {
    super(`${problem}\nFix: ${fix}\nThis needs the user: tell them the fix and do not retry until they have done it.`);
    this.name = 'SimulatorSetupError';
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  /** Bytes of stdout kept; xcodebuild logs run to megabytes. */
  maxBuffer?: number;
  /** Added to the user's command environment. */
  env?: Record<string, string>;
}

/** Runs one toolchain command. Injected so the driver can be tested without Xcode. */
export type Runner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

export class ToolchainCommandError extends Error {
  constructor(
    readonly file: string,
    readonly code: string | number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`${file} failed${code === null ? '' : ` (${code})`}: ${(stderr || stdout).trim().slice(-2000)}`);
    this.name = 'ToolchainCommandError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The user's environment with the PATH a terminal would have, so Homebrew's axe is found. */
export async function toolchainEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await resolveUserPath() };
}

export const runToolchain: Runner = async (file, args, options = {}) => {
  const env = { ...(await toolchainEnv()), ...options.env };
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        env,
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
        signal: options.signal,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        const code = (error as NodeJS.ErrnoException).code ?? null;
        reject(
          new ToolchainCommandError(
            file,
            typeof code === 'string' || typeof code === 'number' ? code : null,
            stdout,
            stderr
          )
        );
      }
    );
  });
};

/**
 * Maps a failed command to the setup problem behind it, or null when the failure is the
 * command's own (a bad scheme, a crashed app) and the model can act on the stderr itself.
 * Matched on Xcode's own wording, which has been stable across releases.
 */
export function diagnoseToolchainFailure(error: unknown): SimulatorSetupError | null {
  if (!(error instanceof ToolchainCommandError)) return null;
  const text = `${error.stderr}\n${error.stdout}`;
  if (error.code === 'ENOENT') {
    if (error.file === 'axe') {
      return new SimulatorSetupError(
        'AXe, which sends taps, swipes and keys to the simulator, is not installed.',
        `run \`${AXE_INSTALL_COMMAND}\` in a terminal. Screenshots, launching and deep links work without it.`
      );
    }
    return new SimulatorSetupError(
      `\`${error.file}\` was not found, so Xcode is not installed.`,
      'install Xcode from the Mac App Store, open it once to finish setup, then try again.'
    );
  }
  if (/agreeing to the Xcode\/iOS license|have not agreed to the Xcode license|license agreements/i.test(text)) {
    return new SimulatorSetupError(
      'The Xcode license has not been accepted, so Xcode tools refuse to run.',
      'run `sudo xcodebuild -license accept` in a terminal.'
    );
  }
  if (/CommandLineTools|unable to find utility "(simctl|xcodebuild)"|invalid active developer path/i.test(text)) {
    return new SimulatorSetupError(
      'The active developer directory is the Command Line Tools, which have no simulator. It must point at Xcode.',
      'run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` in a terminal (adjust the path if Xcode is installed elsewhere).'
    );
  }
  if (/iOS [\d.]+ is not installed|No available simulator runtimes|Unable to find a destination matching/i.test(text)) {
    return new SimulatorSetupError(
      'No iOS simulator runtime matching this build is installed.',
      'run `xcodebuild -downloadPlatform iOS` in a terminal, or add one in Xcode > Settings > Components.'
    );
  }
  return null;
}

/** Rethrows a failure as its setup problem when it is one, unchanged otherwise. */
export function explainToolchainFailure(error: unknown): never {
  throw diagnoseToolchainFailure(error) ?? error;
}
