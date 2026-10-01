import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWithin, realpathNearest } from '../tools/paths';
import { credentialPaths } from '../tools/sandbox';
import { containerDirectory } from './git';

/** The index, loaded into every session; one line per memory and never a memory's contents. */
export const MEMORY_INDEX_FILE = 'MEMORY.md';

/**
 * Ceiling on one memory file. A memory is one fact, so this is far above anything legitimate -
 * it is here to stop a runaway write filling the folder the index has to stay small for.
 */
export const MAX_MEMORY_BYTES = 20_000;

/**
 * A memory's name, which is also its file name and how every other memory links to it.
 *
 * Lowercase letters, digits and single hyphens, and nothing else: no separator, no dot, no
 * extension. The pattern is the first half of the containment argument in `resolveMemoryPath` -
 * `..`, `a/b`, `/etc/passwd` and `.ssh` all fail it before any path is built.
 */
const MEMORY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MemoryStore {
  /** <userInstructionsRoot>/projects/<slug>/memory, the one folder a memory may live in. */
  directory: string;
  /** Kept so the credential deny list can exclude this root; see `deniedPaths`. */
  userInstructionsRoot: string;
}

/**
 * The project's absolute path with every separator turned into a hyphen, leading one included:
 * /Users/someone/code/app becomes -Users-someone-code-app. Claude Code's own scheme, matched
 * exactly so a project that already has memories keeps them.
 */
export function projectSlug(directory: string): string {
  return resolve(directory).replace(/[\\/]/g, '-');
}

/**
 * Where this project's memories live.
 *
 * Keyed on the CONTAINER, not the directory the session happens to be working in: in the
 * bare-repo layout every branch is its own folder, and a memory recorded while working on one
 * branch is still true on the next. One project, one set of memories.
 */
export async function resolveMemoryStore(projectDirectory: string, userInstructionsRoot: string): Promise<MemoryStore> {
  const container = await containerDirectory(projectDirectory).catch(() => projectDirectory);
  return {
    directory: join(userInstructionsRoot, 'projects', projectSlug(container), 'memory'),
    userInstructionsRoot,
  };
}

/**
 * One store per project per process. `containerDirectory` shells out to git, and the answer
 * cannot change while the app is running - a project directory does not move under itself.
 */
const stores = new Map<string, Promise<MemoryStore>>();

export function memoryStoreFor(projectDirectory: string, userInstructionsRoot: string): Promise<MemoryStore> {
  const key = `${projectDirectory}\u0000${userInstructionsRoot}`;
  let held = stores.get(key);
  if (!held) {
    held = resolveMemoryStore(projectDirectory, userInstructionsRoot);
    stores.set(key, held);
  }
  return held;
}

export function assertMemoryName(name: string): string {
  if (!MEMORY_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a memory name. Use lowercase letters, digits and hyphens only ` +
        '(for example local-dev-server-port), with no path, no dot and no .md extension.'
    );
  }
  return name;
}

/**
 * The credential stores, minus the instructions root itself.
 *
 * Same subtraction `instructions.ts:resolveAllowed` makes and for the same reason: that list
 * names ~/.claude, which is the folder this whole feature reads and writes inside, so the one
 * blanket entry cannot stand while every other store - ~/.ssh, ~/.aws, the app's own vault -
 * still must. What replaces it here is narrower than the .md rule there: a memory can only ever
 * be <store>/<kebab-case-name>.md, so .credentials.json is unnameable.
 *
 * Resolved like the roots are, because the candidate is compared after symlinks are collapsed
 * and a deny entry left in its unresolved spelling would never match one - and would fail open.
 * Not `realpathNearest`: a store that does not exist must stay itself rather than collapsing to
 * its nearest existing ancestor, which for ~/.ssh is the whole home folder.
 */
async function deniedPaths(userInstructionsRoot: string): Promise<string[]> {
  const paths = credentialPaths().filter(path => path !== userInstructionsRoot);
  return Promise.all(paths.map(path => realpath(path).catch(() => resolve(path))));
}

/**
 * A memory file's path, proven to point at a memory.
 *
 * This is the part that has to hold. Nothing here is covered by the file tools' granted-roots
 * check - the memory folder is deliberately outside every root the user shared, which is why
 * recall needs a tool of its own - and the model chooses both the name and the bytes. So the
 * name is a slug before it is a path, the result is judged after symlinks are collapsed (a
 * link dropped inside the folder would otherwise aim an approved write at anything on the
 * disk), and the credential stores are refused whatever the link says.
 */
export async function resolveMemoryPath(store: MemoryStore, name: string): Promise<string> {
  const lexical = join(store.directory, `${assertMemoryName(name)}.md`);

  const [real, root, denied] = await Promise.all([
    realpathNearest(lexical),
    realpathNearest(store.directory),
    deniedPaths(store.userInstructionsRoot),
  ]);

  if (!isWithin(root, real)) throw new Error(`Refused: ${name} does not resolve inside the memory folder.`);
  if (denied.some(path => isWithin(path, real) || isWithin(path, lexical))) {
    throw new Error(`Refused: ${name} resolves into a protected location.`);
  }

  // The lexical spelling is what gets written: `real` may be a symlink's target, and writing
  // there would quietly redirect the change the user approved. Safe only because the target was
  // just proven to be inside the memory folder too.
  return lexical;
}

export function memoryIndexPath(store: MemoryStore): string {
  return join(store.directory, MEMORY_INDEX_FILE);
}

export async function readMemoryIndex(store: MemoryStore): Promise<string> {
  return readFile(memoryIndexPath(store), 'utf8').catch(() => '');
}

/** A frontmatter scalar, read without a YAML parser: the block is four fixed keys. */
export function frontmatterValue(text: string, key: string): string | undefined {
  if (!text.startsWith('---\n')) return undefined;
  const end = text.indexOf('\n---', 3);
  const block = end === -1 ? text : text.slice(0, end);
  const match = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(block);
  return match?.[1].trim() || undefined;
}

/** "local-dev-server-port" -> "Local dev server port", for a pointer given no title of its own. */
function titleFromName(name: string): string {
  const words = name.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function pointerFor(name: string, title: string | undefined, hook: string | undefined): string {
  const link = `- [${title?.trim() || titleFromName(name)}](${name}.md)`;
  return hook?.trim() ? `${link} - ${hook.trim().replace(/\s+/g, ' ')}` : link;
}

/** A pointer is identified by what it links to, so retitling a memory still replaces its line. */
function pointsAt(line: string, name: string): boolean {
  return line.includes(`(${name}.md)`);
}

/**
 * The index with `name`'s pointer set to `pointer`, or removed when it is null.
 *
 * Tolerant in both directions, because the index and the folder are two files and either can
 * be the one that is behind: a name with no line yet gains one, a name with several keeps one,
 * and removing a pointer that was never there is not an error. A memory whose pointer is
 * missing is still a memory - it is read by name, not through this file.
 */
export function updateIndex(index: string, name: string, pointer: string | null): string {
  const kept = index.split('\n').filter(line => !pointsAt(line, name));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  if (pointer !== null) kept.push(pointer);
  return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

/** A memory file and its index line, as one change. `after` null is a deletion. */
export interface MemoryPlan {
  name: string;
  path: string;
  indexPath: string;
  /** null when the file does not exist yet. */
  before: string | null;
  after: string | null;
  indexBefore: string;
  indexAfter: string;
}

async function readIfPresent(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

export async function planMemoryWrite(
  store: MemoryStore,
  options: { name: string; content: string; title?: string; hook?: string }
): Promise<MemoryPlan> {
  const path = await resolveMemoryPath(store, options.name);
  const after = options.content.endsWith('\n') ? options.content : `${options.content}\n`;
  if (Buffer.byteLength(after, 'utf8') > MAX_MEMORY_BYTES) {
    throw new Error(`A memory may be at most ${MAX_MEMORY_BYTES} bytes. Keep it to the one fact it records.`);
  }

  const indexBefore = await readMemoryIndex(store);
  const hook = options.hook ?? frontmatterValue(after, 'description');
  return {
    name: options.name,
    path,
    indexPath: memoryIndexPath(store),
    before: await readIfPresent(path),
    after,
    indexBefore,
    indexAfter: updateIndex(indexBefore, options.name, pointerFor(options.name, options.title, hook)),
  };
}

export async function planMemoryDelete(store: MemoryStore, name: string): Promise<MemoryPlan> {
  const path = await resolveMemoryPath(store, name);
  const before = await readIfPresent(path);
  const indexBefore = await readMemoryIndex(store);
  if (before === null && !indexBefore.split('\n').some(line => pointsAt(line, name))) {
    throw new Error(`There is no memory named "${name}", and nothing in ${MEMORY_INDEX_FILE} points at one.`);
  }
  return {
    name,
    path,
    indexPath: memoryIndexPath(store),
    before,
    after: null,
    indexBefore,
    indexAfter: updateIndex(indexBefore, name, null),
  };
}

/**
 * Apply a plan, leaving neither half applied if either fails.
 *
 * The drift this exists to prevent is a file with no pointer, or a pointer to a file that is
 * gone: the index is what every session reads, so an index that disagrees with the folder is
 * how the model comes to believe in a memory nobody wrote. The file moves first because it is
 * the half that can be put back exactly - its previous bytes are in the plan.
 */
export async function applyMemoryPlan(plan: MemoryPlan): Promise<void> {
  await mkdir(dirname(plan.path), { recursive: true });
  if (plan.after === null) await rm(plan.path, { force: true });
  else await writeFile(plan.path, plan.after, 'utf8');

  try {
    await writeFile(plan.indexPath, plan.indexAfter, 'utf8');
  } catch (error) {
    if (plan.before === null) await rm(plan.path, { force: true }).catch(() => undefined);
    else await writeFile(plan.path, plan.before, 'utf8').catch(() => undefined);
    throw error;
  }
}
