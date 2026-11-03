import { readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { parseWslPath, wslLocation, wslRealpath, wslUncPath, type WslLocation } from '../../wsl/wslPath';

/** The kernel's own limit (MAXSYMLINKS); past it the open fails with ELOOP anyway. */
const MAX_LINK_HOPS = 32;

/**
 * Thrown when a tool is pointed outside every granted root. Carries no filesystem detail
 * beyond the path the caller already supplied - the denial message reaches the MODEL, and a
 * probe for "does /Users/someone/secrets exist" must not be answerable from the wording.
 */
export class PathAccessDenied extends Error {
  /** `reason` replaces the default wording for a refusal that is not about the granted set. */
  constructor(requested: string, reason?: string) {
    super(
      reason ??
        `Access denied: ${requested} is outside the folders shared with you. ` +
          'Call request_directory with the folder that holds it and your reason, and the user can ' +
          'add it with one click. Do not tell the user you lack access instead.'
    );
    this.name = 'PathAccessDenied';
  }
}

/** A WSL path with the share name and distro case that do not change where it lands made uniform. */
function comparable(path: string): string {
  const wsl = wslLocation(path);
  return wsl ? wslUncPath({ host: 'wsl.localhost', distro: wsl.distro.toLowerCase() }, wsl.linuxPath) : path;
}

const sameDistro = (a: WslLocation | null, b: WslLocation): boolean =>
  a !== null && a.distro.toLowerCase() === b.distro.toLowerCase();

/** True when `candidate` is `root` itself or lies beneath it. */
export function isWithin(rootPath: string, candidatePath: string): boolean {
  const root = comparable(rootPath);
  const candidate = comparable(candidatePath);
  if (candidate === root) return true;
  // The separator matters: without it "/Users/jude/Downloads-secret" passes a plain
  // startsWith test against "/Users/jude/Downloads".
  return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve a tool-supplied path and confirm it lies inside a granted root.
 *
 * Two resolutions, deliberately:
 *  - the lexical `resolve` handles `..` and relative input;
 *  - `realpath` then collapses symlinks, because a symlink inside a granted root pointing at
 *    /etc would otherwise pass the lexical check and read anything on the disk.
 *
 * A path that does not exist yet cannot be realpath'd, so its nearest existing ancestor is
 * checked instead - that is what makes "create a file here" verifiable without creating it
 * first, while still resolving any symlinked parent along the way.
 */
export async function resolveWithinRoots(
  requested: string,
  roots: readonly string[],
  baseDirectory?: string
): Promise<string> {
  if (!requested) throw new PathAccessDenied(requested);
  if (roots.length === 0) throw new PathAccessDenied(requested);

  // A relative path resolves against the SESSION's working directory, not process.cwd() -
  // which for a packaged Electron app is wherever the app happened to be launched from, and
  // is never somewhere the user granted.
  // In a WSL folder a Linux program writes `/home/...` for a path in its own distro.
  const base = baseDirectory ? wslLocation(baseDirectory) : null;
  const spelled = base && /^\/(?!\/)/.test(requested) ? wslUncPath(base, requested) : requested;
  const lexical = isAbsolute(spelled) || !baseDirectory ? resolve(spelled) : resolve(baseDirectory, spelled);

  const wsl = wslLocation(lexical);
  // Asking a distro no root lives in would start it only to refuse.
  if (wsl && !roots.some(root => sameDistro(wslLocation(root), wsl))) throw new PathAccessDenied(requested);
  const realRoots = await Promise.all(roots.map(root => realRoot(root, wsl)));
  const real = wsl ? await inDistro(wsl, wsl.linuxPath) : await physicalTarget(lexical);
  if (real === null || !realRoots.some(root => isWithin(root, real))) throw new PathAccessDenied(requested);

  // The lexical path is what the caller gets back: `real` may point at the symlink TARGET,
  // and returning that would silently redirect a write the user believes is going elsewhere.
  // It is safe only because the target was just proven to be inside a granted root too.
  return lexical;
}

/**
 * Resolve `requested` the way the KERNEL will, and prove THAT is inside a granted root.
 *
 * For `resolveWithinRoots` above, the lexical collapse is sound, because every caller of it
 * opens the collapsed path it hands back - the kernel is never shown the original spelling, so
 * the path that was checked and the path that is opened are the same string.
 *
 * A shell command is the one case where that does not hold. Its arguments reach bash as
 * written, and the kernel applies `..` to wherever the symlinks BEFORE it actually landed,
 * while `path.resolve` applies it to the name on the left. Those differ exactly when a granted
 * root holds a link back to itself or to an ancestor: with `r/l -> r`, `cat l/../secret` reads
 * `r/../secret` while `resolve` reports `r/secret` and calls it contained. Verified, not
 * assumed.
 *
 * So the components are walked in order here instead, each prefix resolved before the next is
 * applied, which is what lets a `..` land where the kernel will put it. A component that does
 * not exist cannot hide a symlink under it, so from there the rest is appended as written.
 */
export async function resolveWithinRootsPhysically(
  requested: string,
  roots: readonly string[],
  baseDirectory: string
): Promise<string> {
  if (!requested) throw new PathAccessDenied(requested);
  if (roots.length === 0) throw new PathAccessDenied(requested);

  const wsl = wslLocation(baseDirectory);
  if (wsl && !roots.some(root => sameDistro(wslLocation(root), wsl))) throw new PathAccessDenied(requested);
  const realRoots = await Promise.all(roots.map(root => realRoot(root, wsl)));
  const current = wsl ? await physicallyInDistro(wsl, requested) : await physicallyOnHost(requested, baseDirectory);
  if (current === null || !realRoots.some(root => isWithin(root, current))) throw new PathAccessDenied(requested);
  return current;
}

async function physicallyOnHost(requested: string, baseDirectory: string): Promise<string> {
  const prefix = parse(requested).root;
  // A Windows drive-relative path - `C:notes.txt` - has a root and is still not absolute, and
  // the directory it is relative to is per-drive state no part of this app can see. Only ever
  // true on Windows, since `parse` is the posix one everywhere else and reads that as a name.
  if (prefix !== '' && !isAbsolute(requested)) throw new PathAccessDenied(requested);

  let current = prefix === '' ? await realpathOrSelf(resolve(baseDirectory)) : prefix;
  for (const part of requested.slice(prefix.length).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    // `current` is already resolved, so its parent is the one the kernel would step back to.
    current = part === '..' ? dirname(current) : await realpathOrSelf(join(current, part));
  }
  return current;
}

/**
 * A command running in a WSL folder is a Linux process: its argument is resolved by Linux rules,
 * against the folder's Linux path, by the distro itself. A share path to the same distro is read
 * as the Linux path it names.
 */
async function physicallyInDistro(base: WslLocation, requested: string): Promise<string | null> {
  const named = parseWslPath(requested);
  if (named && named.distro.toLowerCase() !== base.distro.toLowerCase()) return null;
  const linux = named
    ? named.linuxPath
    : requested.startsWith('/')
      ? requested
      : `${base.linuxPath.replace(/\/$/, '')}/${requested}`;
  return inDistro(base, linux);
}

/** Linux symlinks under the share do not resolve from Windows, so the distro follows them; null when it cannot. */
async function inDistro(location: WslLocation, linuxPath: string): Promise<string | null> {
  const real = await wslRealpath(location.distro, linuxPath);
  return real === null ? null : wslUncPath(location, real);
}

/** A WSL root is resolved in its distro only when the path checked against it is in that distro too. */
async function realRoot(root: string, checked: WslLocation | null): Promise<string> {
  const wsl = wslLocation(root);
  if (wsl && !(checked && sameDistro(wsl, checked))) return resolve(root);
  const real = wsl ? await inDistro(wsl, wsl.linuxPath) : await realpath(root).catch(() => null);
  return real ?? resolve(root);
}

/**
 * `realpath`, failures included, except that a WSL path has its symlinks followed by its distro;
 * Windows cannot follow them over the share.
 */
export async function hostRealpath(path: string): Promise<string> {
  const wsl = wslLocation(path);
  if (!wsl) return realpath(path);
  const real = await inDistro(wsl, wsl.linuxPath);
  if (real === null) throw new Error(`Cannot resolve ${path} in its WSL distro`);
  // The distro also answers for a path that does not exist, which realpath refuses.
  await stat(real);
  return real;
}

async function realpathOrSelf(target: string): Promise<string> {
  return realpath(target).catch(() => target);
}

/**
 * The real path of `target`, or of its nearest existing ancestor when it does not exist.
 * Walking up terminates at the filesystem root, which always exists.
 */
export async function realpathNearest(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Where opening `target` would land, every symlink followed - including a dangling one, which
 * `open(O_CREAT)` follows to create its target. `realpathNearest` stops at the nearest existing
 * ancestor, so a link in a granted folder aimed at a file that does not exist yet would look
 * like a new file inside the folder.
 */
export async function physicalTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    // A dangling link can contain `..` after another link. Resolve its components in order:
    // path.resolve(directory, link) would collapse that `..` before following the earlier link.
    const absolute = resolve(target);
    let current = parse(absolute).root;
    let pending = absolute.slice(current.length).split(sep);
    let hops = 0;
    while (pending.length > 0) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') {
        current = dirname(current);
        continue;
      }
      const candidate = join(current, part);
      const link = await readlink(candidate).catch(() => null);
      if (link === null) {
        // Existing components also supply their canonical casing on case-insensitive volumes.
        current = await realpath(candidate).catch(() => candidate);
        continue;
      }
      if (++hops > MAX_LINK_HOPS) throw new PathAccessDenied(target);
      const root = parse(link).root;
      if (isAbsolute(link)) current = root;
      pending = [...link.slice(root.length).split(sep), ...pending];
    }
    return current;
  }
}
