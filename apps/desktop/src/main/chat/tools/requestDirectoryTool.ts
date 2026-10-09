import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { parseDirectoryOutcome, REQUEST_DIRECTORY_TOOL_NAME } from '@shared/directoryRequest';
import { isWithin, PathAccessDenied } from './paths';
import { requireString, type ToolDefinition } from './types';

/** Long enough for a real sentence, short enough that the card cannot be filled with prose. */
const MAX_REASON_CHARS = 500;

/**
 * Directories whose contents are the operating system's rather than the user's work. A grant
 * there is still the user's call, so they are warned rather than refused. `/private` is where
 * macOS puts `/etc`, `/var` and `/tmp` once realpath has resolved them.
 */
const SYSTEM_DIRECTORIES = [
  '/System',
  '/Library',
  '/Applications',
  '/bin',
  '/sbin',
  '/usr',
  '/etc',
  '/var',
  '/private',
  '/opt',
  '/dev',
  '/boot',
  '/proc',
  '/sys',
  '/root',
  '/lib',
  '/lib64',
];

/** Inside the home folder, but holding keys, tokens and app state rather than work. */
const SENSITIVE_HOME_DIRECTORIES = ['Library', '.ssh', '.aws', '.gnupg', '.kube', '.docker'];

export type DirectoryInspection =
  /** Settled without a card, with this message to the model. */
  | { kind: 'refused'; message: string }
  /** Already inside a root; nothing to ask. */
  | { kind: 'inside'; path: string }
  | { kind: 'ask'; path: string; reason: string; warning?: string };

export interface DirectoryInspectionContext {
  roots: readonly string[];
  workingDirectory?: string;
  protectedPaths?: readonly string[];
  /** Real paths the user said "Not now" to earlier in this turn. */
  declined: readonly string[];
  /** Injected so tests do not depend on the machine's own home folder. */
  home?: string;
}

/**
 * Decide what a `request_directory` call should do, before any card is drawn.
 *
 * The path shown and granted is the REAL one. A model asking for `~/notes` that is a symlink to
 * `/etc` must put `/etc` in front of the user, because that is what a grant would open; showing
 * the spelling it asked for would have the user approve a name rather than a folder.
 *
 * Existence and kind share one refusal on purpose: the model is outside every root here, and the
 * wording must not tell it "exists but is a file" apart from "does not exist".
 */
export async function inspectDirectoryRequest(
  input: Record<string, unknown>,
  context: DirectoryInspectionContext
): Promise<DirectoryInspection> {
  let requested: string;
  let reason: string;
  try {
    requested = requireString(input, 'path').trim();
    reason = requireString(input, 'reason').trim();
  } catch (err) {
    return { kind: 'refused', message: err instanceof Error ? err.message : String(err) };
  }
  if (!reason) return { kind: 'refused', message: 'The "reason" argument must say why you need the folder.' };
  if (reason.length > MAX_REASON_CHARS) {
    return { kind: 'refused', message: `Keep "reason" to ${MAX_REASON_CHARS} characters or fewer.` };
  }

  const home = context.home ?? homedir();
  const expanded = requested === '~' ? home : requested.startsWith('~/') ? join(home, requested.slice(2)) : requested;
  if (!isAbsolute(expanded) && !context.workingDirectory) {
    return { kind: 'refused', message: `Pass an absolute path (or one starting with ~/); got ${requested}.` };
  }
  const lexical = isAbsolute(expanded) ? resolve(expanded) : resolve(context.workingDirectory as string, expanded);

  // realpath fails on a missing path, which is what makes this an existence check as well.
  const real = await realpath(lexical).catch(() => null);
  const kind = real ? await stat(real).catch(() => null) : null;
  if (!real || !kind?.isDirectory()) {
    return { kind: 'refused', message: `${requested} is not an existing folder, so it cannot be shared.` };
  }

  if (parse(real).root === real) {
    return {
      kind: 'refused',
      message: 'The filesystem root cannot be shared. Ask for the specific folder you need.',
    };
  }
  if ((context.protectedPaths ?? []).some(entry => isWithin(resolve(entry), real))) {
    return { kind: 'refused', message: `${requested} belongs to this app and cannot be shared.` };
  }

  const realRoots = await Promise.all(context.roots.map(root => realpath(root).catch(() => resolve(root))));
  if (realRoots.some(root => isWithin(root, real))) return { kind: 'inside', path: real };

  if (context.declined.some(entry => isWithin(entry, real))) {
    return {
      kind: 'refused',
      message:
        `The user already declined to share ${real} in this turn. Do not ask for it again; ` +
        'continue without it, or explain what you would need it for.',
    };
  }

  const realHome = await realpath(home).catch(() => resolve(home));
  const temporary = await Promise.all([tmpdir(), '/tmp'].map(entry => realpath(entry).catch(() => resolve(entry))));
  const warning = broadPathWarning(real, realHome, temporary);
  return { kind: 'ask', path: real, reason, ...(warning ? { warning } : {}) };
}

/**
 * A caution for a grant much wider than one project, or undefined for an ordinary folder.
 * `temporary` is exempt from the system list: on macOS the temp folders realpath into /private.
 */
export function broadPathWarning(real: string, home: string, temporary: readonly string[] = []): string | undefined {
  if (real === home) return 'This is your whole home folder: every document, key and app setting in it.';
  if (isWithin(real, home)) return 'This folder contains your whole home folder.';
  const sensitive = SENSITIVE_HOME_DIRECTORIES.map(name => join(home, name)).find(entry => isWithin(entry, real));
  if (sensitive) return 'This folder holds credentials and app data, not project files.';
  if (temporary.some(entry => isWithin(entry, real))) return undefined;
  if (SYSTEM_DIRECTORIES.some(entry => isWithin(entry, real))) return 'This is a system folder.';
  return undefined;
}

/**
 * The model asking the user to add a folder to this conversation, answered on a card.
 *
 * Like ask_user, the card IS the interaction and ChatService owns it: it inspects the path,
 * shows the card, performs the grant on the user's click, and hands `run` only the outcome as
 * `input.outcome`. Nothing here widens access, and nothing the model sends can: `outcome` is
 * stripped from its input before the card is drawn.
 */
export const requestDirectory: ToolDefinition = {
  interactive: true,
  schema: {
    name: REQUEST_DIRECTORY_TOOL_NAME,
    description: [
      'Ask the user to add a folder to this conversation, so your file tools can read and change',
      'files in it. The turn pauses on a card showing the folder and your reason; if the user adds',
      'it you continue in the same turn with access, and it stays shared for this conversation.',
      '',
      'Call this whenever you need a file or folder outside the folders already shared with you,',
      'instead of telling the user you have no access or asking them to share it themselves.',
      'Ask for the narrowest folder that holds what you need: the project or the specific',
      'directory, never the home folder or a system folder unless the task truly needs it. A',
      'folder already shared returns at once. If the user declines, do not ask for it again in',
      'this turn: continue without it or explain what you needed it for.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path of the folder, or one starting with ~/. Must be an existing directory.',
        },
        reason: {
          type: 'string',
          description: 'One sentence the user reads on the card: what you need from this folder and why.',
        },
      },
      required: ['path', 'reason'],
    },
  },

  async run(input) {
    const path = typeof input.path === 'string' ? input.path : 'that folder';
    const outcome = parseDirectoryOutcome(input.outcome);
    if (!outcome) throw new Error('The user could not be asked in this context; the folder was not shared.');
    if (outcome.status === 'already') {
      return `${path} is already shared with you in this conversation. Use your file tools on it directly.`;
    }
    if (outcome.status === 'granted') {
      return (
        `The user added ${path} to this conversation. Your file tools can now read and change files ` +
        'in it, for the rest of this conversation. Continue with the task.'
      );
    }
    if (outcome.status === 'declined') {
      throw new PathAccessDenied(
        path,
        `The user chose not to share ${path}. Do not ask for it again in this turn; continue without ` +
          'it, or tell the user what you would have needed it for.'
      );
    }
    throw new Error(
      'The request was closed before the user answered: they stopped the reply or sent a new message. ' +
        'The folder was not shared; follow their new message if there is one.'
    );
  },
};
