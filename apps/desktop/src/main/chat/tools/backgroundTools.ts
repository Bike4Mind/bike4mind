import type { BackgroundProcessInfo } from '@shared/chat';
import { sandboxAvailable } from './sandbox';
import { refusalReason, resolveCwd } from './shellTools';
import {
  capOutput,
  optionalNumber,
  requireString,
  type ApprovalPrompt,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * How long `bash_background` waits before answering.
 *
 * Not zero: a command that dies on startup - a port already taken, a missing script - would
 * otherwise come back as a cheerful handle, and the model would only discover the failure a
 * turn later. Short enough that a server which starts fine is not being waited on.
 */
const SETTLE_MS = 2_000;

const DEFAULT_READ_CHARS = 8_000;
const MAX_READ_CHARS = 20_000;

function requireRegistry(context: ToolContext) {
  if (!context.background) throw new Error('Background commands are not available in this build.');
  return context.background;
}

function requireSessionId(context: ToolContext): string {
  if (!context.sessionId) throw new Error('Background commands need a conversation to belong to.');
  return context.sessionId;
}

function describeStatus(info: BackgroundProcessInfo): string {
  switch (info.status) {
    case 'running':
      return 'running';
    case 'killed':
      return 'stopped';
    case 'failed':
      return `failed to start${info.error ? `: ${info.error}` : ''}`;
    default:
      if (info.exitCode !== null && info.exitCode !== undefined) return `exited ${info.exitCode}`;
      return `killed by ${info.signal ?? 'a signal'}`;
  }
}

function header(info: BackgroundProcessInfo): string {
  return `[${info.id}] $ ${info.command}\n(in ${info.cwd}) - ${describeStatus(info)}`;
}

export const bashBackground: ToolDefinition = {
  schema: {
    name: 'bash_background',
    description: [
      'Start a long-running bash command and leave it running, returning a handle immediately',
      'instead of waiting for it to finish.',
      '',
      'This is the tool for dev servers, file watchers, build --watch, log tailing - anything',
      'that is supposed to keep running. Use bash_execute for commands that finish on their own;',
      'backgrounding those just makes you poll for an answer you could have had directly.',
      '',
      'The user is shown the exact command and must approve it, exactly as with bash_execute,',
      'and they are told it will keep running. The same sandbox applies: it can read the machine',
      'but write only inside the shared folders.',
      '',
      `The call waits about ${SETTLE_MS / 1000}s and returns whatever the command printed in that`,
      'time, so a process that dies immediately is reported as dead rather than as a handle. Read',
      'later output with bash_output, list processes with bash_list, and stop one with bash_kill.',
      '',
      'Every background process is killed when the app quits. None of them survive a restart, so',
      'do not describe one as still running in a later session.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The bash command to start. Do not append "&" - backgrounding is what this tool does.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute path to run in. Must be inside a shared folder. Defaults to the first one.',
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
      detail: [
        `$ ${command}`,
        ...(cwd ? ['', `in ${cwd}`] : []),
        '',
        'Keeps running in the background until stopped.',
      ].join('\n'),
      // A DIFFERENT namespace from bash_execute on purpose: approving `npm run dev` for one
      // 60-second run must not silently also approve leaving it running all afternoon.
      key: `bash_background\x00${cwd}\x00${command}`,
    };
  },

  async run(input, context) {
    const registry = requireRegistry(context);
    const sessionId = requireSessionId(context);
    const command = requireString(input, 'command');

    const refused = refusalReason(command);
    if (refused) throw new Error(`Refused: this command ${refused}. It was not run.`);

    if (!sandboxAvailable()) {
      throw new Error('Commands cannot be run on this machine: the macOS sandbox is unavailable.');
    }

    const cwd = await resolveCwd(input, context.roots);
    const started = await registry.start({
      sessionId,
      command,
      cwd,
      roots: context.roots,
      protectedPaths: context.protectedPaths ?? [],
    });

    await registry.settle(started.id, SETTLE_MS);

    const read = registry.readForModel(started.id, sessionId, DEFAULT_READ_CHARS);
    const info = read?.info ?? started;
    const sections = [header(info)];

    if (read?.text.trim()) sections.push('', read.text.trimEnd());
    else if (info.status === 'running') sections.push('', '[no output yet]');

    sections.push(
      '',
      info.status === 'running'
        ? `[still running - read new output with bash_output id="${info.id}", stop it with bash_kill]`
        : '[the process has already finished; there is nothing left running]'
    );

    return capOutput(sections.join('\n'));
  },
};

export const bashOutput: ToolDefinition = {
  schema: {
    name: 'bash_output',
    description: [
      'Read output from a command started with bash_background.',
      '',
      'Returns only what has arrived since your last bash_output call for that process, so',
      'polling a watcher shows you what it just did rather than repeating its whole history.',
      'Pass from_start: true to re-read everything still buffered.',
      '',
      'Output is buffered as a bounded tail, so a process that has printed megabytes will have',
      'had its oldest output discarded; the result says so explicitly when that has happened.',
      'It also reports whether the process is still running.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The handle returned by bash_background.' },
        from_start: {
          type: 'boolean',
          description: 'Re-read the whole retained buffer instead of only what is new. Default false.',
        },
        max_chars: {
          type: 'number',
          description: `Ceiling on returned characters, newest kept. Default ${DEFAULT_READ_CHARS}, max ${MAX_READ_CHARS}.`,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },

  async run(input, context) {
    const registry = requireRegistry(context);
    const sessionId = requireSessionId(context);
    const id = requireString(input, 'id');

    const requested = optionalNumber(input, 'max_chars');
    const maxChars = Math.min(Math.max(requested ?? DEFAULT_READ_CHARS, 200), MAX_READ_CHARS);

    const read = registry.readForModel(id, sessionId, maxChars, input.from_start === true);
    if (!read) {
      throw new Error(
        `No background process ${id} in this conversation. Use bash_list to see what is running. ` +
          'Processes do not survive the app restarting.'
      );
    }

    const sections = [header(read.info)];
    if (read.missed > 0) sections.push(`[${read.missed} earlier characters were dropped by the output cap]`);
    sections.push('', read.text.trim() ? read.text.trimEnd() : '[no new output]');

    return capOutput(sections.join('\n'));
  },
};

export const bashList: ToolDefinition = {
  schema: {
    name: 'bash_list',
    description: [
      'List the background commands in this conversation - running, and recently finished.',
      '',
      'Use it before starting another server to check one is not already up, and to recover a',
      'handle you no longer have. It lists nothing from before the app was last started.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },

  async run(_input, context) {
    const registry = requireRegistry(context);
    const sessionId = requireSessionId(context);

    const processes = registry.list(sessionId);
    if (processes.length === 0) return 'No background commands have been started in this conversation.';

    const running = processes.filter(info => info.status === 'running');
    const lines = processes.map(info => `[${info.id}] ${describeStatus(info)} - $ ${info.command}  (in ${info.cwd})`);

    return capOutput(
      [`${running.length} running, ${processes.length - running.length} finished`, '', ...lines].join('\n')
    );
  },
};

export const bashKill: ToolDefinition = {
  schema: {
    name: 'bash_kill',
    description: [
      'Stop a command started with bash_background, together with everything it spawned.',
      '',
      'It is sent SIGTERM and then SIGKILL if it does not stop. Do this as soon as a background',
      'process is no longer needed - a dev server left running holds its port.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The handle returned by bash_background.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },

  // Deliberately ungated. Stopping a process the user already approved takes nothing away
  // from them, and a stop worth doing is worth doing without a second dialog.
  async run(input, context) {
    const registry = requireRegistry(context);
    const sessionId = requireSessionId(context);
    const id = requireString(input, 'id');

    const info = await registry.kill(id, sessionId);
    if (!info) throw new Error(`No background process ${id} in this conversation.`);

    const tail = registry.tail(id, sessionId, 2_000)?.trimEnd();
    return capOutput([header(info), ...(tail ? ['', '[last output]', tail] : [])].join('\n'));
  },
};
