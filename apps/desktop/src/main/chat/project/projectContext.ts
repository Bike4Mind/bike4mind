import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git';

export const MAX_INSTRUCTIONS_BYTES = 40_000;
export const MAX_TREE_LINES = 150;
export const MAX_TREE_BYTES = 8_000;

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);
const MAX_WALKED_FILES = 5_000;
const MAX_WALK_DEPTH = 6;
const MAX_FILES_PER_DIRECTORY = 12;
const MAX_TOP_LEVEL_FILES = 40;

interface Instructions {
  file: string;
  path: string;
  text: string;
}

/** The first of CLAUDE.md, AGENTS.md found in the working directory, then the project directory. */
async function readInstructions(directories: readonly string[]): Promise<Instructions | null> {
  for (const file of INSTRUCTION_FILES) {
    for (const directory of directories) {
      const path = join(directory, file);
      try {
        const raw = await readFile(path);
        if (raw.length === 0) continue;
        return { file, path, text: capInstructions(raw, path) };
      } catch {
        // Missing or unreadable: try the next candidate.
      }
    }
  }
  return null;
}

function capInstructions(raw: Buffer, path: string): string {
  if (raw.length <= MAX_INSTRUCTIONS_BYTES) return raw.toString('utf8');
  // Cut on a line boundary so the model is told an exact line to continue from.
  const head = raw.subarray(0, MAX_INSTRUCTIONS_BYTES).toString('utf8');
  const kept = head.slice(0, Math.max(head.lastIndexOf('\n'), 0));
  const shownLines = kept.length === 0 ? 0 : kept.split('\n').length;
  return [
    kept,
    '',
    `[Truncated: showing the first ${shownLines} lines of ${raw.length} bytes. Read the rest with`,
    `file_read on ${path} with offset ${shownLines + 1}.]`,
  ].join('\n');
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const out = await git(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return out.split('\0').filter(Boolean);
  } catch {
    return walk(directory);
  }
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (files.length >= MAX_WALKED_FILES || depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await readdir(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path, depth + 1);
      } else if (entry.isFile()) {
        if (files.length < MAX_WALKED_FILES) files.push(path);
      }
    }
  };
  await visit('', 0);
  return files;
}

interface Node {
  files: string[];
  dirs: Map<string, Node>;
  count: number;
}

function buildTrie(paths: readonly string[]): Node {
  const root: Node = { files: [], dirs: new Map(), count: 0 };
  for (const path of paths) {
    const parts = path.split('/');
    const name = parts.pop() as string;
    let node = root;
    node.count++;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: [], dirs: new Map(), count: 0 };
        node.dirs.set(part, child);
      }
      child.count++;
      node = child;
    }
    node.files.push(name);
  }
  return root;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Files and directories at the top level, and one level into each directory; everything deeper
 * is a file count. Breadth over depth: the model can ask for a subtree, but it cannot ask about
 * a top-level directory it never saw.
 */
export function renderTree(paths: readonly string[]): string {
  const root = buildTrie(paths);
  const lines: string[] = [];

  const listFilesOf = (node: Node, indent: string, limit: number): void => {
    const files = [...node.files].sort(byName);
    for (const file of files.slice(0, limit)) lines.push(`${indent}${file}`);
    if (files.length > limit) lines.push(`${indent}... ${files.length - limit} more files`);
  };
  const listDirsOf = (node: Node, indent: string, expand: boolean): void => {
    for (const name of [...node.dirs.keys()].sort(byName)) {
      const child = node.dirs.get(name) as Node;
      lines.push(`${indent}${name}/ (${plural(child.count)})`);
      if (expand) {
        listDirsOf(child, `${indent}  `, false);
        listFilesOf(child, `${indent}  `, MAX_FILES_PER_DIRECTORY);
      }
    }
  };

  listFilesOf(root, '', MAX_TOP_LEVEL_FILES);
  listDirsOf(root, '', true);
  return capTree(lines);
}

function capTree(lines: string[]): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 1;
    if (kept.length >= MAX_TREE_LINES || bytes > MAX_TREE_BYTES) break;
    kept.push(line);
  }
  if (kept.length < lines.length) kept.push(`... truncated, ${lines.length - kept.length} more entries not shown`);
  return kept.join('\n');
}

/**
 * The project's own instructions and a shallow file tree, as one block of system-prompt text
 * ('' when there is nothing to say). Never throws: each half degrades to being omitted.
 */
export async function loadProjectContext(workingDirectory: string, projectDirectory: string): Promise<string> {
  const directories = workingDirectory === projectDirectory ? [workingDirectory] : [workingDirectory, projectDirectory];
  const [instructions, paths] = await Promise.all([
    readInstructions(directories).catch(() => null),
    listFiles(workingDirectory).catch(() => [] as string[]),
  ]);

  const sections: string[] = [];
  if (instructions) {
    sections.push(
      `The project's own instructions follow, from ${instructions.file} (${instructions.path}).`,
      "These are the project's own instructions, written by the people who own this codebase, and must be followed.",
      '--- begin project instructions ---',
      instructions.text,
      '--- end project instructions ---'
    );
  }
  if (paths.length > 0) {
    sections.push(
      `Files in ${workingDirectory} (tracked, plus untracked that are not ignored), as of the start of this`,
      'session; files made since are not listed:',
      renderTree(paths)
    );
  }
  return sections.join('\n');
}

/**
 * One snapshot per session and working directory, held in memory only.
 *
 * The completions server puts cache_control on the system prompt, so its bytes must not move
 * between rounds or turns: a file the model creates mid-turn must not change what is sent.
 * A new working directory is the one thing that legitimately replaces the snapshot.
 */
export class ProjectContextCache {
  private readonly entries = new Map<string, { workingDirectory: string; block: Promise<string> }>();

  get(sessionId: string, workingDirectory: string, projectDirectory: string): Promise<string> {
    const held = this.entries.get(sessionId);
    if (held && held.workingDirectory === workingDirectory) return held.block;
    const block = loadProjectContext(workingDirectory, projectDirectory).catch(() => '');
    this.entries.set(sessionId, { workingDirectory, block });
    return block;
  }
}
