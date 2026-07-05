import { ToolDefinition } from '../../base/types';
import { spawn } from 'child_process';
import path from 'path';

interface BashExecuteParams {
  command: string;
  cwd?: string;
  timeout?: number;
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

/**
 * Execute a bash command with safety checks
 */
async function executeBashCommand(params: BashExecuteParams): Promise<BashExecuteResult> {
  const { command, cwd: relativeCwd, timeout = DEFAULT_TIMEOUT_MS } = params;

  // Validate command is not empty
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

  // Check for dangerous patterns
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

  // Resolve working directory (allows any path, including outside cwd)
  const baseCwd = process.cwd();
  const targetCwd = relativeCwd ? path.resolve(baseCwd, relativeCwd) : baseCwd;

  // Ensure timeout is reasonable (max 5 minutes)
  const effectiveTimeout = Math.min(timeout, 5 * 60 * 1000);

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Spawn bash process
    const proc = spawn('bash', ['-c', command], {
      cwd: targetCwd,
      env: {
        ...process.env,
        // Prevent color codes that might be hard to read
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
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
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    // Collect stderr with size limit
    proc.stderr.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    // Handle process completion
    proc.on('close', exitCode => {
      clearTimeout(timeoutId);
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
              'Timeout in milliseconds (optional, default: 60000, max: 300000). Command will be terminated if it exceeds this time.',
          },
        },
        required: ['command'],
      },
    },
  }),
};
