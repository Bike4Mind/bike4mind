import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isWithin, realpathNearest } from '../tools/paths';
import { credentialPaths } from '../tools/sandbox';

/**
 * Bytes of instructions that may reach the system prompt, across every file and every import
 * together. It was a per-file cap when only one file could ever be found; layering plus imports
 * make an unbounded number of files reachable, and this block is re-sent on every round of every
 * turn, so the ceiling has to be on the total.
 */
export const MAX_INSTRUCTIONS_BYTES = 40_000;

/** How far an import may pull another import. Claude Code's depth, for the same reason: a chain. */
export const MAX_IMPORT_DEPTH = 5;

const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const USER_INSTRUCTION_FILE = 'CLAUDE.md';

/** Where the user's own instructions live, shared with the skills loader's ~/.claude convention. */
export function defaultUserInstructionsRoot(): string {
  return join(homedir(), '.claude');
}

export type InstructionScope = 'user' | 'project';

export interface InstructionBlock {
  scope: InstructionScope;
  /** The file's own name, for the model to recognise; `path` is what locates it. */
  file: string;
  path: string;
  text: string;
}

/**
 * The shared byte allowance, spent in the order blocks are read rather than shared out evenly:
 * whoever asks first keeps its bytes. Callers read the most specific file first so that a project's
 * own instructions survive a tight budget and the general ones are what gets cut.
 */
class Budget {
  private remaining: number;

  constructor(total: number) {
    this.remaining = total;
  }

  get exhausted(): boolean {
    return this.remaining <= 0;
  }

  /** `raw` capped to what is left, or null once nothing is. */
  take(raw: Buffer, path: string): string | null {
    if (this.remaining <= 0) return null;
    if (raw.length <= this.remaining) {
      this.remaining -= raw.length;
      return raw.toString('utf8');
    }
    // Cut on a line boundary so the model is told an exact line to continue from.
    const head = raw.subarray(0, this.remaining).toString('utf8');
    const kept = head.slice(0, Math.max(head.lastIndexOf('\n'), 0));
    this.remaining = 0;
    const shownLines = kept.length === 0 ? 0 : kept.split('\n').length;
    return [
      kept,
      '',
      `[Truncated: showing the first ${shownLines} lines of ${raw.length} bytes. Read the rest with`,
      `file_read on ${path} with offset ${shownLines + 1}.]`,
    ].join('\n');
  }
}

interface Allowed {
  /** Real paths an import may resolve inside. */
  roots: readonly string[];
  denied: readonly string[];
}

interface ImportContext {
  /**
   * Resolved on the first import and then reused. Almost no instruction file has one, and this
   * runs for every session, so the dozen realpath calls are not worth making up front.
   */
  allowed: () => Promise<Allowed>;
  budget: Budget;
}

/**
 * The instruction files that apply, most general first: the user's own, then the project's.
 *
 * Never throws - a file that cannot be read is simply absent, because an unreadable import must
 * not cost the session the instructions that did load.
 */
export async function loadInstructions(
  workingDirectory: string | undefined,
  projectDirectory: string | undefined,
  userInstructionsRoot: string
): Promise<InstructionBlock[]> {
  const directories = [workingDirectory, projectDirectory].filter((value): value is string => !!value);
  let allowed: Promise<Allowed> | null = null;
  const context: ImportContext = {
    allowed: () => (allowed ??= resolveAllowed(directories, userInstructionsRoot)),
    budget: new Budget(MAX_INSTRUCTIONS_BYTES),
  };

  // Most specific first: it spends from the budget before the general file sees it.
  const project = await readBlock('project', await findProjectFile(directories), context);
  const user = await readBlock('user', await findFile(join(userInstructionsRoot, USER_INSTRUCTION_FILE)), context);

  return [user, project].filter((block): block is InstructionBlock => block !== null);
}

async function resolveAllowed(directories: readonly string[], userInstructionsRoot: string): Promise<Allowed> {
  const [roots, denied] = await Promise.all([
    realPaths([...directories, userInstructionsRoot]),
    // `credentialPaths()` lists ~/.claude, which is also where the user's instructions live, so
    // that one entry cannot stand: the feature is reading a file inside it. Every other store -
    // ~/.ssh, ~/.aws, the app's own token vault - still applies, and what replaces the blanket
    // denial over ~/.claude is the .md rule in `resolveImport`, which keeps .credentials.json out.
    //
    // Resolved like the roots are, and for the same reason sandbox.ts resolves its own copies:
    // the candidate is compared after symlinks are collapsed, so a deny entry left in its
    // unresolved spelling would never match one - and would fail open.
    realPaths(credentialPaths().filter(path => path !== userInstructionsRoot)),
  ]);
  return { roots, denied };
}

/** Each path with symlinks collapsed, falling back to the lexical form when it does not exist. */
async function realPaths(paths: readonly string[]): Promise<string[]> {
  const resolved = await Promise.all(paths.map(path => realpath(path).catch(() => resolve(path))));
  return [...new Set(resolved)];
}

interface Found {
  file: string;
  path: string;
  raw: Buffer;
}

async function findFile(path: string): Promise<Found | null> {
  try {
    const raw = await readFile(path);
    return raw.length === 0 ? null : { file: path.split('/').pop() ?? path, path, raw };
  } catch {
    return null;
  }
}

/** The first of CLAUDE.md, AGENTS.md found in the working directory, then the project directory. */
async function findProjectFile(directories: readonly string[]): Promise<Found | null> {
  for (const file of PROJECT_INSTRUCTION_FILES) {
    for (const directory of directories) {
      const found = await findFile(join(directory, file));
      if (found) return found;
    }
  }
  return null;
}

async function readBlock(
  scope: InstructionScope,
  found: Found | null,
  context: ImportContext
): Promise<InstructionBlock | null> {
  if (!found) return null;
  const body = context.budget.take(found.raw, found.path);
  if (body === null) return null;
  const text = await expandImports(body, found.path, context, 0, new Set([found.path]));
  return { scope, file: found.file, path: found.path, text };
}

/**
 * `@path` pulls another file in after the line that named it, recursively.
 *
 * The line itself is kept: it is usually the sentence that says what the import is for, and
 * keeping it means nesting reads unambiguously against the markers around the pulled-in text.
 */
async function expandImports(
  text: string,
  importerPath: string,
  context: ImportContext,
  depth: number,
  seen: ReadonlySet<string>
): Promise<string> {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    out.push(line);
    if (fenced) continue;
    for (const spec of importSpecs(line)) {
      out.push(...(await importedBlock(spec, importerPath, context, depth, seen)));
    }
  }
  return out.join('\n');
}

/** `@path` at a word boundary, so an email address or a decorator is not an import. */
function importSpecs(line: string): string[] {
  const withoutCode = line.replace(/`[^`]*`/g, '');
  return [...withoutCode.matchAll(/(?:^|\s)@(\S+)/g)].map(match => match[1].replace(/[.,;:)\]]+$/, ''));
}

async function importedBlock(
  spec: string,
  importerPath: string,
  context: ImportContext,
  depth: number,
  seen: ReadonlySet<string>
): Promise<string[]> {
  if (depth >= MAX_IMPORT_DEPTH) return [note(spec, `not followed, imports go only ${MAX_IMPORT_DEPTH} deep`)];

  let path: string;
  try {
    path = await resolveImport(spec, importerPath, context);
  } catch (error) {
    return [note(spec, (error as Error).message)];
  }
  if (seen.has(path)) return [note(spec, 'already included above')];

  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    return [note(spec, 'not found')];
  }
  const body = context.budget.take(raw, path);
  if (body === null) return [note(spec, 'left out, the instruction budget is full')];

  const inner = await expandImports(body, path, context, depth + 1, new Set([...seen, path]));
  return [`<!-- begin import ${path} -->`, inner, `<!-- end import ${path} -->`];
}

function note(spec: string, reason: string): string {
  return `[import @${spec} ${reason}.]`;
}

/**
 * An import's path, proven to point somewhere an instruction file may legitimately live.
 *
 * This is the part that has to hold. These files are read by the main process, which the file
 * tools' granted-roots check never sees, and a project's CLAUDE.md is a file the model can write
 * with an ordinary approved edit. An unbounded resolver would therefore turn one edit into
 * `@~/.ssh/id_rsa` in the next turn's system prompt, sent to the provider with nothing left to
 * approve. So: markdown only, inside the project tree or the user's instructions folder, judged
 * after symlinks are collapsed, and never inside a credential store.
 */
async function resolveImport(spec: string, importerPath: string, context: ImportContext): Promise<string> {
  const expanded = spec.startsWith('~/') ? join(homedir(), spec.slice(2)) : spec;
  const lexical = isAbsolute(expanded) ? resolve(expanded) : resolve(dirname(importerPath), expanded);
  if (!lexical.toLowerCase().endsWith('.md')) throw new Error('refused, only .md files can be imported');

  // The nearest existing ancestor, so a path that does not exist is refused by where it points
  // rather than by whether it is there - the reason it was refused must not answer "does
  // /Users/someone/secrets exist" for anything outside the roots.
  const real = await realpathNearest(lexical);
  const { roots, denied } = await context.allowed();
  if (!roots.some(root => isWithin(root, real))) {
    throw new Error('refused, outside this project and your instructions folder');
  }
  if (denied.some(path => isWithin(path, real))) throw new Error('refused, a protected path');

  // The lexical spelling is what gets read: `real` may be a symlink's target, and reading that
  // would quietly follow a link somewhere other than where the file says. Safe only because the
  // target was just proven to be inside a root too.
  return lexical;
}
