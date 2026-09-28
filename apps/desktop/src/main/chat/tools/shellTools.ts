import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveWithinRoots } from './paths';
import { sandboxAvailable, sandboxCommand } from './sandbox';
import { capOutput, optionalNumber, requireString, type ApprovalPrompt, type ToolDefinition } from './types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/** Per stream. The model pays for this text on every later turn, the endpoint being stateless. */
const MAX_STREAM_BYTES = 40_000;

/** Grace between asking the process group to stop and killing it outright. */
const SIGKILL_DELAY_MS = 3_000;

/**
 * Commands refused before the sandbox ever sees them.
 *
 * Defence in depth, not the defence: the approval gate is what the user actually relies on, and
 * a pattern list over shell text is easy to slip past. These are here because a user skimming an
 * approval prompt should never be one tired click away from `sudo` or a fork bomb.
 */
const REFUSED: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b/i, reason: 'runs with elevated privileges' },
  { pattern: /\bsu\s+(-|root)\b/i, reason: 'switches to the root user' },
  { pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/i, reason: 'recursively force-deletes a root path' },
  { pattern: /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(\s|$)/i, reason: 'recursively force-deletes a root path' },
  { pattern: /--no-preserve-root/i, reason: 'disables the root delete guard' },
  { pattern: /\bmkfs\b/i, reason: 'formats a filesystem' },
  { pattern: /\bfdisk\b/i, reason: 'repartitions a disk' },
  { pattern: /\bdd\s+[^|;]*\bof=\/dev\//i, reason: 'writes directly to a device' },
  { pattern: /\b(nc|netcat)\s+[^|;]*-e\s+\/bin\/(ba)?sh/i, reason: 'opens a reverse shell' },
  { pattern: /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba)?sh/i, reason: 'pipes a remote script into a shell' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, reason: 'is a fork bomb' },
  { pattern: /\bLD_PRELOAD\s*=/i, reason: 'injects a library into every process' },
  { pattern: /\bkill\s+-9\s+-?1\b/, reason: 'kills every process' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, reason: 'shuts the machine down' },
];

function refusalReason(command: string): string | null {
  return REFUSED.find(entry => entry.pattern.test(command))?.reason ?? null;
}

interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Collects a stream up to a byte ceiling, decoding incrementally so a multi-byte character
 * split across two chunks is not turned into replacement characters.
 */
class CappedOutput {
  private readonly decoder = new StringDecoder('utf8');
  private text = '';
  private bytes = 0;
  private dropped = 0;

  push(chunk: Buffer): void {
    if (this.bytes >= MAX_STREAM_BYTES) {
      this.dropped += chunk.length;
      return;
    }
    const room = MAX_STREAM_BYTES - this.bytes;
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.dropped += chunk.length - kept.length;
    this.bytes += kept.length;
    this.text += this.decoder.write(kept);
  }

  toString(): string {
    const tail = this.decoder.end();
    const body = this.text + tail;
    return this.dropped > 0 ? `${body}\n[truncated: ${this.dropped} more bytes]` : body;
  }
}

function runCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      // Its own process group, so the timeout reaches the command's children too: signalling
      // sandbox-exec alone would leave the bash it spawned, and whatever that spawned, running.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, B4M_DESKTOP_SANDBOX: '1' },
    });

    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalGroup = (value: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, value);
      } catch {
        // Already gone, or the group outlived its leader; nothing left to signal.
      }
    };

    const stopChild = () => {
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), SIGKILL_DELAY_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, timeoutMs);

    const onAbort = () => stopChild();
    signal.addEventListener('abort', onAbort, { once: true });

    const finish = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    child.on('error', error => {
      finish();
      reject(error);
    });

    child.on('close', (code, closeSignal) => {
      finish();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code,
        signal: closeSignal,
        timedOut,
      });
    });

    if (signal.aborted) stopChild();
  });
}

function formatOutcome(command: string, cwd: string, timeoutMs: number, outcome: CommandOutcome): string {
  const sections = [`$ ${command}`, `(in ${cwd})`];

  if (outcome.stdout.trim()) sections.push('', outcome.stdout.trimEnd());
  if (outcome.stderr.trim()) sections.push('', '[stderr]', outcome.stderr.trimEnd());

  if (outcome.timedOut) {
    sections.push('', `[timed out and was killed after ${Math.round(timeoutMs / 1000)}s]`);
  } else if (outcome.exitCode === 0) {
    sections.push('', '[exit 0]');
  } else if (outcome.exitCode !== null) {
    sections.push('', `[exit ${outcome.exitCode}]`);
  } else {
    sections.push('', `[killed by ${outcome.signal ?? 'a signal'}]`);
  }

  if (!outcome.stdout.trim() && !outcome.stderr.trim()) sections.push('[no output]');

  return sections.join('\n');
}

/**
 * Where the command runs. The model may name a directory, but only one inside a granted root:
 * the sandbox lets it WRITE nowhere else, and starting it somewhere unrelated would just be a
 * confusing way to fail.
 */
async function resolveCwd(input: Record<string, unknown>, roots: readonly string[]): Promise<string> {
  const requested = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : null;
  if (requested) return resolveWithinRoots(requested, roots);
  if (roots.length === 0) throw new Error('No folder has been shared, so there is nowhere to run a command.');
  return roots[0];
}

export const bashExecute: ToolDefinition = {
  schema: {
    name: 'bash_execute',
    description: [
      'Run a bash command on the user machine and return its output.',
      '',
      'The user is shown the exact command and must approve it before it runs, so state plainly',
      'what you are about to do and why. A denial is an answer, not an error to work around: do',
      'not rephrase the same command to get past it.',
      '',
      'The command runs sandboxed. It can read the machine, but it can only WRITE inside the',
      'folders the user has shared. Credential stores (~/.ssh, ~/.aws, keychains) are unreadable.',
      '',
      'Use it for git, builds, tests, package managers and system inspection. It blocks until the',
      `command exits or the timeout elapses (default ${DEFAULT_TIMEOUT_MS / 1000}s, max`,
      `${MAX_TIMEOUT_MS / 1000}s), so do not start dev servers, watchers or anything long-lived.`,
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to run. Pipes, redirects and chained commands are allowed.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute path to run in. Must be inside a shared folder. Defaults to the first one.',
        },
        timeout: {
          type: 'number',
          description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },

  approval(input: Record<string, unknown>): ApprovalPrompt {
    const command = typeof input.command === 'string' ? input.command : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    return {
      detail: cwd ? `$ ${command}\n\nin ${cwd}` : `$ ${command}`,
      // Keyed on both, and on the exact text: "always allow" must not carry from `git status`
      // to a longer command sharing that prefix, nor from one directory to another. NUL
      // separates the fields because it is the one byte neither of them can contain.
      key: `bash_execute\x00${cwd}\x00${command}`,
    };
  },

  async run(input, context) {
    const command = requireString(input, 'command');

    const refused = refusalReason(command);
    if (refused) throw new Error(`Refused: this command ${refused}. It was not run.`);

    // No unsandboxed fallback. A desktop client that quietly ran the command anyway when
    // confinement was unavailable would be offering a guarantee it is not keeping.
    if (!sandboxAvailable()) {
      throw new Error('Commands cannot be run on this machine: the macOS sandbox is unavailable.');
    }

    const cwd = await resolveCwd(input, context.roots);
    const requestedTimeout = optionalNumber(input, 'timeout');
    const timeoutMs = Math.min(Math.max(requestedTimeout ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

    const sandboxed = await sandboxCommand(command, context.roots, context.protectedPaths ?? []);
    try {
      const outcome = await runCommand(sandboxed.executable, sandboxed.args, cwd, timeoutMs, context.signal);
      return capOutput(formatOutcome(command, cwd, timeoutMs, outcome));
    } finally {
      await sandboxed.cleanup();
    }
  },
};
