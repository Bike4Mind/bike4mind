import { ToolDefinition } from '../../base/types';
import {
  getShellSessionManager,
  isTerminalShellStatus,
  type ShellSession,
  type ShellSessionManager,
  type ShellSessionStatus,
} from '../bashExecute/ShellSessionManager';

const STATUS_ICONS: Record<ShellSessionStatus, string> = {
  running: '⏳',
  exited: '✅',
  killed: '🚫',
  timed_out: '⏱️',
};

const INTERRUPT_CHAR = '\x03';

function elapsedSeconds(session: ShellSession): number {
  return Math.round(((session.endTime ?? Date.now()) - session.startTime) / 1000);
}

/** Human summary line for a session (used by list_background_shells). */
function summarizeSession(session: ShellSession): string {
  const icon = STATUS_ICONS[session.status] ?? '❓';
  const exit = session.exitCode !== null ? ` exit ${session.exitCode}` : '';
  const command = session.command.length > 80 ? session.command.slice(0, 77) + '...' : session.command;
  return `${icon} [${session.id}] ${session.status}${exit} (${elapsedSeconds(session)}s) - ${command}`;
}

// --- Manager-injectable logic (testable without the process-global singleton) ---

export function checkShellOutput(manager: ShellSessionManager, sessionId: string, sinceOffset?: number): string {
  const session = manager.get(sessionId);
  if (!session) return `No background shell found with id: ${sessionId}`;

  const slice = manager.getOutput(sessionId, sinceOffset);
  const running = !isTerminalShellStatus(session.status);
  const exit = session.exitCode !== null ? ` (exit ${session.exitCode})` : '';

  const lines: string[] = [`[${session.id}] ${session.status}${exit}, ${elapsedSeconds(session)}s elapsed`];
  if (slice?.truncated) {
    lines.push('(earlier output dropped - buffer limit reached)');
  }
  lines.push('', slice?.output?.trim() ? slice.output.trimEnd() : '(no new output)');
  lines.push('', `Next poll offset: ${slice?.offset ?? 0}${running ? ' (still running)' : ''}`);
  return lines.join('\n');
}

// SECURITY BOUNDARY: bash_execute's dangerous-pattern filter only inspects the
// initial command. Stdin written here goes straight to a live process with NO
// pattern filtering - a backgrounded shell/REPL could be driven to run anything.
// This is gated instead by write_shell_stdin being permission-prompted on every
// call (see toolSafety: 'prompt_always') plus the CLI sandbox wrapping.
export function writeShellStdin(manager: ShellSessionManager, sessionId: string, chars: string): string {
  const session = manager.get(sessionId);
  if (!session) return `No background shell found with id: ${sessionId}`;

  const ok = manager.writeStdin(sessionId, chars);
  if (!ok) return `Cannot write to session ${sessionId} - status is "${session.status}".`;

  return chars.includes(INTERRUPT_CHAR)
    ? `Sent interrupt (Ctrl-C) to session ${sessionId}. Poll check_shell_output to see the result.`
    : `Wrote input to session ${sessionId}. Poll check_shell_output to see the response.`;
}

export function listBackgroundShells(manager: ShellSessionManager): string {
  const sessions = manager.list();
  if (sessions.length === 0) return 'No background shell sessions.';
  return sessions.map(summarizeSession).join('\n');
}

export function killBackgroundShell(manager: ShellSessionManager, sessionId: string): string {
  const session = manager.get(sessionId);
  if (!session) return `No background shell found with id: ${sessionId}`;

  const killed = manager.kill(sessionId);
  return killed
    ? `Background shell ${sessionId} has been terminated.`
    : `Cannot kill session ${sessionId} - status is already "${session.status}".`;
}

// --- ToolDefinitions (thin wrappers over the singleton manager) ---

interface CheckShellOutputParams {
  session_id: string;
  since_offset?: number;
}
interface WriteShellStdinParams {
  session_id: string;
  chars: string;
}
interface KillShellParams {
  session_id: string;
}

export const checkShellOutputTool: ToolDefinition = {
  name: 'check_shell_output',
  implementation: () => ({
    toolFn: async (value: unknown) => {
      const { session_id, since_offset } = value as CheckShellOutputParams;
      if (!session_id) throw new Error('check_shell_output: session_id is required');
      return checkShellOutput(getShellSessionManager(), session_id, since_offset);
    },
    toolSchema: {
      name: 'check_shell_output',
      description:
        'Poll the output of a background shell session started by bash_execute. Returns output produced since the given offset (omit to read all retained output), plus the session status and the next poll offset.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session id returned by bash_execute.' },
          since_offset: {
            type: 'number',
            description:
              'Only return output produced after this offset (use the "Next poll offset" from a prior call).',
          },
        },
        required: ['session_id'],
      },
    },
  }),
};

export const writeShellStdinTool: ToolDefinition = {
  name: 'write_shell_stdin',
  implementation: () => ({
    toolFn: async (value: unknown) => {
      const { session_id, chars } = value as WriteShellStdinParams;
      if (!session_id) throw new Error('write_shell_stdin: session_id is required');
      if (typeof chars !== 'string') throw new Error('write_shell_stdin: chars must be a string');
      return writeShellStdin(getShellSessionManager(), session_id, chars);
    },
    toolSchema: {
      name: 'write_shell_stdin',
      description:
        'Write to the stdin of a running background shell session. Include a newline to submit a line. A lone \\x03 (Ctrl-C) interrupts the process instead of being sent as input.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session id returned by bash_execute.' },
          chars: { type: 'string', description: 'Characters to write to stdin. Use \\x03 to send an interrupt.' },
        },
        required: ['session_id', 'chars'],
      },
    },
  }),
};

export const listBackgroundShellsTool: ToolDefinition = {
  name: 'list_background_shells',
  implementation: () => ({
    toolFn: async () => listBackgroundShells(getShellSessionManager()),
    toolSchema: {
      name: 'list_background_shells',
      description: 'List all background shell sessions with their status, elapsed time, and command.',
      parameters: { type: 'object', properties: {} },
    },
  }),
};

export const killBackgroundShellTool: ToolDefinition = {
  name: 'kill_background_shell',
  implementation: () => ({
    toolFn: async (value: unknown) => {
      const { session_id } = value as KillShellParams;
      if (!session_id) throw new Error('kill_background_shell: session_id is required');
      return killBackgroundShell(getShellSessionManager(), session_id);
    },
    toolSchema: {
      name: 'kill_background_shell',
      description: 'Terminate a running background shell session (kills the whole process group).',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The session id to terminate.' },
        },
        required: ['session_id'],
      },
    },
  }),
};
