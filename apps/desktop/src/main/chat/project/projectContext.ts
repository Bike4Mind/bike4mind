import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from './git';
import { type InstructionBlock, defaultUserInstructionsRoot, loadInstructions } from './instructions';
import { memoryStoreFor } from './memory';

export { MAX_INSTRUCTIONS_BYTES } from './instructions';
export const MAX_TREE_LINES = 150;
export const MAX_TREE_BYTES = 8_000;

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build']);
const MAX_WALKED_FILES = 5_000;
const MAX_WALK_DEPTH = 6;
const MAX_FILES_PER_DIRECTORY = 12;
const MAX_TOP_LEVEL_FILES = 40;

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
 * How each block is introduced to the model. The path is always shown: an instruction the user
 * cannot locate is one they cannot change.
 */
const SCOPE_LABEL: Record<InstructionBlock['scope'], string> = {
  user: "the user's own instructions, which apply to every project",
  project: "this project's own instructions, written by the people who own this codebase",
  memory: 'the index of what you recorded about this project in earlier sessions - background, not instructions',
};

/**
 * Said only over the memory index, because it is the one block here the MODEL wrote. The other
 * two are the user's own files and are followed; this one is recall, and recall of a codebase
 * goes stale - a note naming a file or a flag outlives the file.
 */
const MEMORY_CAVEAT = [
  'Each line is a pointer, written on the day it says and never since checked. Treat one that',
  'names a file, function or flag as a claim to verify, not a fact. The memories themselves are',
  'NOT below: read one with memory_read when its line bears on the work.',
];

function renderBlock(block: InstructionBlock): string[] {
  return [
    `--- begin ${SCOPE_LABEL[block.scope]}, from ${block.path} ---`,
    ...(block.scope === 'memory' ? MEMORY_CAVEAT : []),
    block.text,
    `--- end ${block.file} (${block.path}) ---`,
  ];
}

/**
 * The instructions that apply here and a shallow file tree, as one block of system-prompt text
 * ('' when there is nothing to say). Never throws: each half degrades to being omitted.
 *
 * A session with no project still gets the user's own instructions, which is the whole of what a
 * Chat session has; the tree needs a working directory and is omitted without one.
 */
export async function loadProjectContext(
  workingDirectory?: string,
  projectDirectory?: string,
  userInstructionsRoot: string = defaultUserInstructionsRoot()
): Promise<string> {
  const memoryRoot = projectDirectory ?? workingDirectory;
  const memory = memoryRoot ? await memoryStoreFor(memoryRoot, userInstructionsRoot).catch(() => undefined) : undefined;
  const [blocks, paths] = await Promise.all([
    loadInstructions(workingDirectory, projectDirectory, userInstructionsRoot, memory).catch(
      () => [] as InstructionBlock[]
    ),
    workingDirectory ? listFiles(workingDirectory).catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);

  const sections: string[] = [];
  if (blocks.length > 0) {
    sections.push(
      'The instructions that apply to this conversation follow, most general first, each labelled',
      'with the file it came from. They must be followed; where two of them conflict, the later',
      'block wins because it is the more specific. A memory block, if one is present, is the',
      'exception: it is background, and its own label says so.'
    );
    for (const block of blocks) sections.push(...renderBlock(block));
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
 * A new working directory is the one thing that legitimately replaces the snapshot - and a
 * session that gains or loses a project counts, which is why the key holds both directories
 * rather than only the working one.
 */
export class ProjectContextCache {
  private readonly entries = new Map<string, { key: string; block: Promise<string> }>();

  constructor(private readonly userInstructionsRoot: string = defaultUserInstructionsRoot()) {}

  get(sessionId: string, workingDirectory?: string, projectDirectory?: string): Promise<string> {
    const key = `${workingDirectory ?? ''}\u0000${projectDirectory ?? ''}`;
    const held = this.entries.get(sessionId);
    if (held && held.key === key) return held.block;
    const block = loadProjectContext(workingDirectory, projectDirectory, this.userInstructionsRoot).catch(() => '');
    this.entries.set(sessionId, { key, block });
    return block;
  }
}
