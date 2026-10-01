import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { BackgroundProcessInfo } from '@shared/chat';
import type { OutputStream } from './outputBuffer';
import { resolveWithinRoots } from './paths';
import { commandEnv, launchCommand } from './commandLaunch';
import type { SandboxedCommand } from './sandbox';
import {
  capOutputMiddle,
  optionalNumber,
  requireString,
  type ApprovalPrompt,
  type ToolContext,
  type ToolDefinition,
} from './types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

/** Per stream. The model pays for this text on every later turn, the endpoint being stateless. */
const MAX_STREAM_BYTES = 40_000;

/** Grace between asking the process group to stop and killing it outright. */
const SIGKILL_DELAY_MS = 3_000;

/** Long enough for the runner's final summary lines to land after the idle marker. */
const WATCH_GRACE_MS = 1_500;

/** A marker can straddle two chunks; this much of the previous text is rescanned. */
const WATCH_SCAN_CARRY = 256;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** What a watch-mode tool prints once it has finished its pass and is idling for edits. */
const WATCH_MARKERS: readonly RegExp[] = [
  /waiting for file changes/i,
  /press h to show help/i,
  /watch usage/i,
  /press w to show more/i,
  /watching for file changes/i,
  /waiting for changes/i,
];

const WATCH_FAILURE = /\b[1-9]\d* failed\b|\bFAIL\b|\b[1-9]\d* errors?\b|error TS\d+/;

/** What the background registry needs to take a running command over; see `moveToBackground`. */
export interface Handover {
  child: ChildProcess;
  /** The detached child's own pid, which is its process group id. */
  pgid: number | null;
  /** Everything collected so far, so nothing that scrolled past before the move is lost. */
  captured: readonly { stream: OutputStream; text: string }[];
}

export interface RunOptions {
  watchGraceMs?: number;
  /**
   * Offer this run to the user as movable while it is in flight. Returns the withdrawal, which
   * is called the moment the command settles on its own.
   */
  offerMove?(move: () => BackgroundProcessInfo | null): () => void;
  /** Perform the handover. Required alongside `offerMove`; throwing leaves the command running. */
  adopt?(handover: Handover): BackgroundProcessInfo;
}

/**
 * Commands refused before they are run.
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

/** Exported so backgrounding a command cannot be a way around the same refusals. */
export function refusalReason(command: string): string | null {
  return REFUSED.find(entry => entry.pattern.test(command))?.reason ?? null;
}

/**
 * A leading `bash -lc`, `sh -c`, `zsh -lc` and so on - a second shell wrapped around the script.
 *
 * Anchored at the start, and only for the `-c` form, because that is the one that is a mistake:
 * the command already reaches bash as a single argv entry (see commandLaunch), so a wrapper here
 * is a layer of quoting that bash strips before the inner shell ever sees it. A model writing one
 * has to escape every inner quote as '"'"' to survive it, and on a script dense with jq filters
 * and sed expressions it gets that wrong and the command arrives mangled or empty. Elsewhere in
 * the line - `echo bash -lc`, `grep 'bash -c' src`, a pipe into `xargs bash -c` - it is data or a
 * deliberate nested shell, and neither is ours to second-guess. `env` and a long flag are allowed
 * in front because `/usr/bin/env bash -c` and `bash --login -c` are the same mistake spelled out.
 */
const SHELL_WRAPPER =
  /^\s*(?:(?:\S*\/)?env[ \t]+)?(?:\S*\/)?(bash|zsh|dash|sh)((?:[ \t]+--?[A-Za-z][\w-]*)*[ \t]+-[A-Za-z]*c[A-Za-z]*)(?=[ \t]|$)/;

/**
 * The error a double-wrapped command is refused with, or null when there is no wrapper.
 *
 * A refusal rather than an unwrap: unquoting it here means doing exactly what the shell would,
 * and getting that subtly wrong would run something other than what the approval card showed.
 * The model can resend the inner script in the same turn.
 */
export function doubleWrapRefusal(command: string): string | null {
  const match = SHELL_WRAPPER.exec(command);
  if (!match) return null;

  const wrapper = `${match[1]}${match[2]}`.replace(/[ \t]+/g, ' ');
  return [
    `Refused: this command starts with \`${wrapper}\`, which wraps the script in a second shell.`,
    'The command string is handed straight to bash; nothing re-parses it afterwards, so the outer',
    'shell only strips a layer of quoting off the script before it runs. Resend the inner script on',
    'its own, written the way you would type it at a prompt. It was not run.',
  ].join(' ');
}

interface CommandOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  watchStopped: boolean;
  /** Set instead of an exit: the user moved the command to the background and it is still running. */
  movedToBackground?: BackgroundProcessInfo;
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
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
  options: RunOptions = {}
): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      // Its own process group, so the timeout reaches the command's children too: signalling
      // the shell alone would leave whatever it spawned running. It is also what lets the
      // command be moved to the background intact - see `moveToBackground` below.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    let timedOut = false;
    let watchStopped = false;
    let moved = false;
    let watchTimer: NodeJS.Timeout | undefined;
    let scanTail = '';
    let killTimer: NodeJS.Timeout | undefined;
    let withdrawMove: (() => void) | undefined;

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
      if (watchTimer) clearTimeout(watchTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      withdrawMove?.();
    };

    // One decoder per stream so a split multi-byte character cannot corrupt the scan text.
    const scanDecoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const scan = (chunk: Buffer, decoder: StringDecoder) => {
      if (watchTimer) return;
      const text = (scanTail + decoder.write(chunk)).replace(ANSI, '');
      if (WATCH_MARKERS.some(marker => marker.test(text))) {
        watchTimer = setTimeout(() => {
          watchStopped = true;
          stopChild();
        }, options.watchGraceMs ?? WATCH_GRACE_MS);
        return;
      }
      scanTail = text.slice(-WATCH_SCAN_CARRY);
    };

    const onStdout = (chunk: Buffer) => {
      stdout.push(chunk);
      scan(chunk, scanDecoders[0]);
    };
    const onStderr = (chunk: Buffer) => {
      stderr.push(chunk);
      scan(chunk, scanDecoders[1]);
    };
    const onError = (error: Error) => {
      finish();
      reject(error);
    };
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
      finish();
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: code,
        signal: closeSignal,
        timedOut,
        watchStopped,
      });
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);

    /**
     * Hand the running child over and answer the pending call at once.
     *
     * `adopt` goes FIRST and nothing is torn down until it has returned: it enforces the
     * background process cap and throws when the cap is full, and a command refused there must
     * be left exactly as it was, still running in the foreground on its original deadline.
     *
     * Once it has, every way this runner would have stopped the command on the FOREGROUND's
     * schedule has to go: the timeout, the abort wiring and the watch-mode grace are all
     * deadlines the user has just overruled, and one left armed would kill the promoted process
     * minutes later with nothing on screen to explain it. The pipe and exit listeners go with
     * them, so the registry is the only reader of the output from here on.
     */
    const moveToBackground = (): BackgroundProcessInfo | null => {
      if (moved || !options.adopt) return null;
      const info = options.adopt({
        child,
        pgid: child.pid ?? null,
        captured: [
          { stream: 'stdout', text: stdout.toString() },
          { stream: 'stderr', text: stderr.toString() },
        ],
      });

      moved = true;
      finish();
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);

      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        watchStopped: false,
        movedToBackground: info,
      });
      return info;
    };

    if (options.adopt && options.offerMove) withdrawMove = options.offerMove(moveToBackground);

    if (signal.aborted) stopChild();
  });
}

function formatOutcome(command: string, cwd: string, timeoutMs: number, outcome: CommandOutcome): string {
  const sections = [`$ ${command}`, `(in ${cwd})`];

  if (outcome.stdout.trim()) sections.push('', outcome.stdout.trimEnd());
  if (outcome.stderr.trim()) sections.push('', '[stderr]', outcome.stderr.trimEnd());

  if (outcome.watchStopped) {
    const failed = WATCH_FAILURE.test(`${outcome.stdout}\n${outcome.stderr}`.replace(ANSI, ''));
    sections.push(
      '',
      '[stopped: the command entered watch mode and was waiting for file changes. It ran once; the results are above.',
      'Run it without watch mode, e.g. `vitest run`, or drop -w/--watch.]',
      failed
        ? '[exit 1: the output before watch mode shows failures]'
        : '[exit 0: the output before watch mode shows no failures]'
    );
  } else if (outcome.timedOut) {
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
 * the granted folders are what the session is about, and starting somewhere unrelated would
 * just be a confusing way to work.
 *
 * The default is the session's working directory when it has one. Falling back to `roots[0]`
 * for a Code session would run the command in whichever folder was granted first - for a
 * session bound to a worktree, that is the main checkout, which is exactly the confusion this
 * mode exists to remove.
 */
export async function resolveCwd(
  input: Record<string, unknown>,
  roots: readonly string[],
  workingDirectory?: string
): Promise<string> {
  const requested = typeof input.cwd === 'string' && input.cwd.length > 0 ? input.cwd : null;
  if (requested) return resolveWithinRoots(requested, roots, workingDirectory);
  if (workingDirectory) return workingDirectory;
  if (roots.length === 0) throw new Error('No folder has been shared, so there is nowhere to run a command.');
  return roots[0];
}

/** Exported so tests can shrink the grace period. */
export const bashExecuteRunOptions: RunOptions = {};

/**
 * The move wiring for one call, or nothing when this build or this context cannot offer it.
 *
 * All four pieces are needed and any of them may be absent outside the chat loop - a tool run
 * from a test has no call to key an offer on, and no registry to put it in.
 */
function movableOptions(
  context: ToolContext,
  started: { command: string; cwd: string; startedAt: string; launch: SandboxedCommand }
): RunOptions {
  const { foreground, background, sessionId, callId } = context;
  if (!foreground || !background || !sessionId || !callId) return {};

  return {
    offerMove: move => foreground.register(sessionId, callId, move),
    adopt: handover => background.adopt({ sessionId, ...started, ...handover }),
  };
}

function formatMoved(command: string, cwd: string, info: BackgroundProcessInfo): string {
  return [
    `$ ${command}`,
    `(in ${cwd})`,
    '',
    `[the user moved this command to the background; it is still running as [${info.id}]]`,
    `[bash_output id="${info.id}" returns everything it has printed, including what it printed`,
    'before the move. bash_kill stops it.]',
  ].join('\n');
}

export const bashExecute: ToolDefinition = {
  schema: {
    name: 'bash_execute',
    description: [
      'Run a bash command on the user machine and return its output.',
      '',
      'The string you pass is handed to bash as it stands and nothing re-parses it afterwards, so',
      'write it the way you would type it at a prompt. Do not put `bash -lc`, `bash -c`, `sh -c`,',
      '`zsh -c` or any other shell in front of it, and do not add an outer layer of quoting to go',
      'with one: that layer is stripped before your script runs, every inner quote then has to be',
      'escaped to survive it, and a command that starts with such a wrapper is refused rather than',
      'run. Pipes, redirects, `&&`, heredocs and multi-line scripts all work as written.',
      '',
      'Pass `cwd` to run somewhere other than the default folder rather than opening with a `cd`.',
      '',
      'The user is shown the exact command and must approve it before it runs, so state plainly',
      'what you are about to do and why. A denial is an answer, not an error to work around: do',
      'not rephrase the same command to get past it.',
      '',
      'The command runs as the user, with their full environment: their PATH, git credentials,',
      'gh login and keychain all work, and it can read and write anywhere they can. Only the',
      'working directory must be inside a shared folder.',
      '',
      'Use it for git, builds, tests, package managers and system inspection. It blocks until the',
      `command exits or the timeout elapses (default ${DEFAULT_TIMEOUT_MS / 1000}s, max`,
      `${MAX_TIMEOUT_MS / 1000}s), so it is the wrong tool for a dev server, a watcher or anything`,
      'else meant to keep running: start those with bash_background instead.',
      '',
      'Raise `timeout` up front for anything that loops over network calls - a script making one',
      '`gh api` or `curl` call per item will outrun the default long before it is finished.',
      '',
      'Commands must exit on their own. Never use watch flags (-w, --watch) here: use `vitest run` /',
      '`jest --watchAll=false`. pnpm passes flags after the script name to the script, so',
      '`pnpm test -w` runs the tests in watch mode, which is stopped after its first pass.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The bash command to run, exactly as you would type it at a prompt. Pipes, redirects ' +
            'and chained commands are allowed. Never prefix it with `bash -lc` or another shell.',
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

    // Here as well as in run() so the user is never asked to approve a command that is going to
    // be refused anyway - a throw from approval() settles the call without a card.
    const wrapped = doubleWrapRefusal(command);
    if (wrapped) throw new Error(wrapped);

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

    const wrapped = doubleWrapRefusal(command);
    if (wrapped) throw new Error(wrapped);

    const refused = refusalReason(command);
    if (refused) throw new Error(`Refused: this command ${refused}. It was not run.`);

    const cwd = await resolveCwd(input, context.roots, context.workingDirectory);
    const requestedTimeout = optionalNumber(input, 'timeout');
    const timeoutMs = Math.min(Math.max(requestedTimeout ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

    const launch = await launchCommand(command, context.roots, context.protectedPaths ?? []);
    const startedAt = new Date().toISOString();
    let moved = false;
    try {
      const env = await commandEnv();
      const outcome = await runCommand(launch.executable, launch.args, cwd, env, timeoutMs, context.signal, {
        ...bashExecuteRunOptions,
        ...movableOptions(context, { command, cwd, startedAt, launch }),
      });

      if (outcome.movedToBackground) {
        moved = true;
        context.report?.moved();
        return formatMoved(command, cwd, outcome.movedToBackground);
      }
      return capOutputMiddle(formatOutcome(command, cwd, timeoutMs, outcome));
    } finally {
      // The background registry owns the launch once it has the child, and runs this cleanup
      // itself when the command finally ends.
      if (!moved) await launch.cleanup();
    }
  },
};
