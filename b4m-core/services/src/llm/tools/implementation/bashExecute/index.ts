import { ToolDefinition } from '../../base/types';
import { spawn } from 'child_process';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import {
  getShellSessionManager,
  isTerminalShellStatus,
  type ShellSession,
  type ShellSessionManager,
} from './ShellSessionManager';

interface BashExecuteParams {
  command: string;
  cwd?: string;
  timeout?: number;
  /** Start the command as a background session and return a session_id immediately. */
  run_in_background?: boolean;
  /**
   * Foreground grace window (ms). If the command is still running after this, it is
   * promoted to a background session (returning a session_id) instead of being killed.
   */
  yield_time_ms?: number;
}

interface BashExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  blocked: boolean;
  blockedReason?: string;
}

// Default timeout: 60 seconds
const DEFAULT_TIMEOUT_MS = 60_000;

// Maximum output size: 100KB
const MAX_OUTPUT_SIZE = 100 * 1024;

/**
 * Dangerous command patterns that should be blocked or warned about.
 * These patterns are checked against the full command string.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string; block: boolean }> = [
  // Destructive file operations
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*\s+-[a-zA-Z]*r).*\//i,
    reason: 'Recursive delete with path',
    block: true,
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*\s+-[a-zA-Z]*f).*--no-preserve-root/i,
    reason: 'Force delete without preserve root',
    block: true,
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//i,
    reason: 'Recursive force delete on root paths',
    block: true,
  },
  {
    pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\//i,
    reason: 'Force recursive delete on root paths',
    block: true,
  },

  // System-level dangerous commands
  { pattern: /\bsudo\b/i, reason: 'Elevated privileges (sudo)', block: true },
  { pattern: /\bsu\s+(-|root)/i, reason: 'Switch to root user', block: true },
  { pattern: /\bchmod\s+777\b/i, reason: 'Overly permissive chmod', block: false },
  { pattern: /\bchown\s+-R\s+root/i, reason: 'Recursive chown to root', block: true },

  // Disk/partition operations
  { pattern: /\bmkfs\b/i, reason: 'Filesystem creation', block: true },
  { pattern: /\bfdisk\b/i, reason: 'Disk partitioning', block: true },
  { pattern: /\bdd\s+.*of=\/dev\//i, reason: 'Direct disk write', block: true },

  // Network attacks
  { pattern: /\b(nc|netcat)\s+.*-e\s+\/bin\/(ba)?sh/i, reason: 'Reverse shell attempt', block: true },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh/i, reason: 'Piping remote script to shell', block: true },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh/i, reason: 'Piping remote script to shell', block: true },

  // Fork bombs and resource exhaustion
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/i, reason: 'Fork bomb', block: true },
  { pattern: /\bwhile\s+true.*do.*done.*&/i, reason: 'Infinite loop in background', block: false },

  // Credential/sensitive data access
  { pattern: /\/etc\/shadow/i, reason: 'Access to shadow file', block: true },
  { pattern: /\/etc\/passwd.*>/i, reason: 'Modifying passwd file', block: true },
  { pattern: /\baws\s+.*--profile\s+/i, reason: 'AWS profile access', block: false },

  // History/log manipulation
  { pattern: /\bhistory\s+-c\b/i, reason: 'Clearing shell history', block: false },
  { pattern: />\s*\/var\/log\//i, reason: 'Overwriting system logs', block: true },

  // Dangerous redirects
  { pattern: />\s*\/dev\/sda/i, reason: 'Writing to block device', block: true },
  { pattern: />\s*\/dev\/null.*2>&1.*</i, reason: 'Potentially hiding output', block: false },

  // Environment manipulation
  { pattern: /\bexport\s+PATH\s*=\s*[^$]/i, reason: 'Overwriting PATH', block: false },
  { pattern: /\bexport\s+LD_PRELOAD/i, reason: 'LD_PRELOAD manipulation', block: true },

  // Process/system control
  { pattern: /\bkill\s+-9\s+(-1|1)\b/i, reason: 'Killing all processes', block: true },
  { pattern: /\bkillall\s+-9\b/i, reason: 'Force killing processes', block: false },
  { pattern: /\bshutdown\b/i, reason: 'System shutdown', block: true },
  { pattern: /\breboot\b/i, reason: 'System reboot', block: true },
  { pattern: /\binit\s+[06]\b/i, reason: 'System runlevel change', block: true },
];

/**
 * Commands that are generally safe and commonly used in development
 */
const SAFE_COMMAND_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'echo',
  'pwd',
  'whoami',
  'date',
  'cal',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'sed',
  'awk',
  'git',
  'npm',
  'pnpm',
  'yarn',
  'node',
  'npx',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'pip',
  'pip3',
  'docker',
  'docker-compose',
  'curl',
  'wget', // These are safe for fetching, blocked when piped to shell
  'mkdir',
  'touch',
  'cp',
  'mv', // File operations (still require permission)
  'which',
  'whereis',
  'type',
  'file',
  'stat',
  'env',
  'printenv',
  'set',
  'man',
  'help',
  'info',
  'diff',
  'comm',
  'cmp',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'ssh',
  'scp',
  'rsync', // Network tools
  'make',
  'cmake',
  'cargo',
  'go',
  'rustc',
  'gcc',
  'g++', // Build tools
  'jest',
  'vitest',
  'mocha',
  'pytest', // Test runners
  'eslint',
  'prettier',
  'tsc', // Linters/formatters
];

/**
 * Check if a command matches any dangerous patterns
 */
function checkDangerousPatterns(command: string): { blocked: boolean; reason?: string } {
  for (const { pattern, reason, block } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: block, reason };
    }
  }
  return { blocked: false };
}

/**
 * Get the base command from a command string
 */
function getBaseCommand(command: string): string {
  // Remove leading whitespace and get first word
  const trimmed = command.trim();
  const match = trimmed.match(/^(\S+)/);
  return match ? match[1] : '';
}

/**
 * Check if command starts with a safe prefix
 */
function isSafeCommandPrefix(command: string): boolean {
  const baseCommand = getBaseCommand(command);
  return SAFE_COMMAND_PREFIXES.some(safe => baseCommand === safe || baseCommand.endsWith(`/${safe}`));
}

/** Max hard timeout for a foreground command (5 minutes). */
const MAX_FOREGROUND_TIMEOUT_MS = 5 * 60 * 1000;

/** Grace window before a `run_in_background` command returns its session id. */
const BACKGROUND_GRACE_MS = 250;

/**
 * Run the empty-command and dangerous-pattern safety checks shared by the
 * foreground and background paths. Returns a blocked result, or null if the
 * command may proceed.
 */
function precheckCommand(command: string): BashExecuteResult | null {
  if (!command || command.trim().length === 0) {
    return {
      stdout: '',
      stderr: 'Error: Command cannot be empty',
      exitCode: 1,
      timedOut: false,
      blocked: true,
      blockedReason: 'Empty command',
    };
  }

  const dangerCheck = checkDangerousPatterns(command);
  if (dangerCheck.blocked) {
    return {
      stdout: '',
      stderr: `Command blocked for safety: ${dangerCheck.reason}`,
      exitCode: 1,
      timedOut: false,
      blocked: true,
      blockedReason: dangerCheck.reason,
    };
  }

  return null;
}

/** Resolve a (possibly relative) cwd against the process cwd. */
function resolveCwd(relativeCwd?: string): string {
  const baseCwd = process.cwd();
  return relativeCwd ? path.resolve(baseCwd, relativeCwd) : baseCwd;
}

/** Environment for spawned commands: inherit, but suppress color codes. */
function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
}

/**
 * Execute a bash command with safety checks (foreground, blocking).
 */
export async function executeBashCommand(params: BashExecuteParams): Promise<BashExecuteResult> {
  const { command, cwd: relativeCwd, timeout = DEFAULT_TIMEOUT_MS } = params;

  const blocked = precheckCommand(command);
  if (blocked) return blocked;

  // Resolve working directory (allows any path, including outside cwd)
  const targetCwd = resolveCwd(relativeCwd);

  // Ensure timeout is reasonable (max 5 minutes)
  const effectiveTimeout = Math.min(timeout, MAX_FOREGROUND_TIMEOUT_MS);

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Per-stream decoders so a multibyte char split across data chunks isn't garbled.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    // Spawn bash process
    const proc = spawn('bash', ['-c', command], {
      cwd: targetCwd,
      env: buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      // Force kill after 5 seconds if SIGTERM doesn't work
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, effectiveTimeout);

    // Collect stdout with size limit
    proc.stdout.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += outDecoder.write(data);
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    // Collect stderr with size limit
    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += errDecoder.write(data);
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    // Handle process completion
    proc.on('close', exitCode => {
      clearTimeout(timeoutId);
      // Flush any bytes buffered mid-codepoint at stream end.
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        blocked: false,
      });
    });

    // Handle process errors
    proc.on('error', error => {
      clearTimeout(timeoutId);
      resolve({
        stdout: '',
        stderr: `Failed to execute command: ${error.message}`,
        exitCode: 1,
        timedOut: false,
        blocked: false,
      });
    });
  });
}

/**
 * Format the result for display
 */
function formatResult(result: BashExecuteResult, command: string): string {
  const parts: string[] = [];

  // Add command info
  parts.push(`$ ${command}`);
  parts.push('');

  // Check if blocked
  if (result.blocked) {
    parts.push(`BLOCKED: ${result.blockedReason}`);
    parts.push('');
    parts.push('This command was blocked for safety reasons.');
    parts.push('If you believe this is a false positive, please run the command manually.');
    return parts.join('\n');
  }

  // Add timeout warning
  if (result.timedOut) {
    parts.push('WARNING: Command timed out and was terminated.');
    parts.push('');
  }

  // Add stdout
  if (result.stdout) {
    parts.push(result.stdout);
  }

  // Add stderr (if any)
  if (result.stderr) {
    if (result.stdout) {
      parts.push('');
    }
    parts.push('STDERR:');
    parts.push(result.stderr);
  }

  // Add exit code if non-zero
  if (result.exitCode !== 0 && result.exitCode !== null) {
    parts.push('');
    parts.push(`Exit code: ${result.exitCode}`);
  }

  // Handle empty output
  if (!result.stdout && !result.stderr && !result.timedOut) {
    parts.push('(command completed with no output)');
  }

  return parts.join('\n');
}

/** Resolve when the session reaches a terminal status, or after `timeoutMs`. */
function waitForSettleOrTimeout(
  manager: ShellSessionManager,
  sessionId: string,
  timeoutMs: number
): Promise<ShellSession | undefined> {
  return new Promise(resolve => {
    const current = manager.get(sessionId);
    if (!current || isTerminalShellStatus(current.status)) {
      resolve(current);
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve(manager.get(sessionId));
    };

    const timer = setTimeout(finish, timeoutMs);
    const unsubscribe = manager.subscribe(session => {
      if (session.id === sessionId && isTerminalShellStatus(session.status)) {
        finish();
      }
    });
  });
}

/** Format the outcome of a background/yield session for the model. */
export function formatSessionResult(session: ShellSession, output: string): string {
  const parts: string[] = [`$ ${session.command}`, ''];

  if (isTerminalShellStatus(session.status)) {
    const exit = session.exitCode === null ? session.status : `exit ${session.exitCode}`;
    parts.push(`[session ${session.id} finished: ${exit}]`);
    if (output.trim()) {
      parts.push('', output.trim());
    } else {
      parts.push('', '(no output)');
    }
    return parts.join('\n');
  }

  // Still running - hand back a session id and the polling contract.
  parts.push(`[background session started: ${session.id} - still running]`);
  parts.push(
    `Poll with check_shell_output (session_id: "${session.id}"), send input with write_shell_stdin, stop with kill_background_shell.`
  );
  if (output.trim()) {
    parts.push('', 'Output so far:', output.trim());
  }
  return parts.join('\n');
}

/**
 * Run a command as a shell session, waiting up to `waitMs` for it to settle.
 * Returns the full output if it finishes in time, otherwise a session id to poll.
 */
export async function executeBackgroundSession(
  params: BashExecuteParams,
  waitMs: number,
  manager: ShellSessionManager = getShellSessionManager()
): Promise<string> {
  const blocked = precheckCommand(params.command);
  if (blocked) return formatResult(blocked, params.command);

  let session: ShellSession;
  try {
    session = manager.spawn(params.command, resolveCwd(params.cwd), buildEnv());
  } catch (error) {
    // e.g. the concurrent-running-session cap was hit - surface it so the model
    // knows to free a slot rather than treating it as an execution failure.
    return `$ ${params.command}\n\n[cannot start background session] ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  const settled = await waitForSettleOrTimeout(manager, session.id, waitMs);
  const current = settled ?? session;
  const output = manager.getOutput(session.id)?.output ?? '';
  return formatSessionResult(current, output);
}

export const bashExecuteTool: ToolDefinition = {
  name: 'bash_execute',
  implementation: context => ({
    toolFn: async value => {
      const params = value as BashExecuteParams;
      const isSafe = isSafeCommandPrefix(params.command);

      context.logger.info('Bash: Executing command', {
        command: params.command,
        cwd: params.cwd || '.',
        timeout: params.timeout || DEFAULT_TIMEOUT_MS,
        isSafeCommand: isSafe,
      });

      // Notify start
      if (context.onStart) {
        await context.onStart('bash_execute', {
          command: params.command,
          cwd: params.cwd,
        });
      }

      try {
        // Session mode: run_in_background returns a session id after a short grace;
        // yield_time_ms promotes a still-running foreground command to a session
        // instead of killing it at the timeout.
        const isSessionMode = params.run_in_background === true || typeof params.yield_time_ms === 'number';
        if (isSessionMode) {
          const waitMs = params.run_in_background
            ? BACKGROUND_GRACE_MS
            : Math.min(Math.max(params.yield_time_ms ?? BACKGROUND_GRACE_MS, 0), MAX_FOREGROUND_TIMEOUT_MS);
          const sessionResult = await executeBackgroundSession(params, waitMs);

          if (context.onFinish) {
            await context.onFinish('bash_execute', { command: params.command, background: true });
          }
          return sessionResult;
        }

        const result = await executeBashCommand(params);
        const formattedResult = formatResult(result, params.command);

        context.logger.info('Bash: Command completed', {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          blocked: result.blocked,
        });

        // Notify finish
        if (context.onFinish) {
          await context.onFinish('bash_execute', {
            command: params.command,
            exitCode: result.exitCode,
            blocked: result.blocked,
          });
        }

        return formattedResult;
      } catch (error) {
        context.logger.error('Bash: Command failed', error);

        // Notify finish with error
        if (context.onFinish) {
          await context.onFinish('bash_execute', {
            command: params.command,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }

        throw error;
      }
    },
    toolSchema: {
      name: 'bash_execute',
      description: `Execute a bash command in the terminal. Use this for running shell commands, scripts, build tools, git operations, and other CLI tasks.

SAFETY NOTES:
- Commands are executed in the current working directory (or specified cwd)
- Dangerous commands (sudo, rm -rf /, etc.) are automatically blocked
- Commands have a default timeout of 60 seconds (max 5 minutes)
- Output is limited to prevent overwhelming responses
- This tool ALWAYS requires user permission before execution

LONG-RUNNING / BACKGROUND COMMANDS:
- Set run_in_background: true for dev servers, watchers, or anything long-lived. Returns a
  session_id immediately instead of blocking. Then poll it with check_shell_output, feed it
  input with write_shell_stdin, and stop it with kill_background_shell.
- Set yield_time_ms to run a command in the foreground but, if it is still going after that
  window, hand back a session_id (and keep it running) instead of killing it at the timeout.

COMMON USE CASES:
- Running build commands: npm run build, make, cargo build
- Git operations: git status, git log, git diff
- Viewing system info: ls, pwd, cat, head, tail
- Running tests: npm test, pytest, cargo test
- Package management: npm install, pip install
- File operations: mkdir, cp, mv (with permission)

BLOCKED OPERATIONS:
- sudo and privilege escalation
- Recursive deletes on system paths
- Direct disk operations
- Fork bombs and resource exhaustion
- Piping remote scripts to shell`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute. Can include pipes, redirects, and chained commands.',
          },
          cwd: {
            type: 'string',
            description:
              'Working directory for the command (optional). Can be relative or absolute path. Defaults to current directory.',
          },
          timeout: {
            type: 'number',
            description:
              'Timeout in milliseconds (optional, default: 60000, max: 300000). Command will be terminated if it exceeds this time. Ignored in background/yield mode.',
          },
          run_in_background: {
            type: 'boolean',
            description:
              'Optional. Start the command as a background session and return a session_id immediately (for dev servers, watchers, long builds). Poll with check_shell_output.',
          },
          yield_time_ms: {
            type: 'number',
            description:
              'Optional. Run in the foreground but, if still running after this many ms, return a session_id and keep it running instead of killing it.',
          },
        },
        required: ['command'],
      },
    },
  }),
};
