import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

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
        `Access denied: ${requested} is outside the folders you have granted. ` +
          'Ask the user to add that folder from the chip row above the message box.'
    );
    this.name = 'PathAccessDenied';
  }
}

/** True when `candidate` is `root` itself or lies beneath it. */
export function isWithin(root: string, candidate: string): boolean {
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
  const lexical = isAbsolute(requested) || !baseDirectory ? resolve(requested) : resolve(baseDirectory, requested);
  const realRoots = await Promise.all(roots.map(root => realpath(root).catch(() => resolve(root))));

  const real = await realpathNearest(lexical);
  if (!realRoots.some(root => isWithin(root, real))) throw new PathAccessDenied(requested);

  // The lexical path is what the caller gets back: `real` may point at the symlink TARGET,
  // and returning that would silently redirect a write the user believes is going elsewhere.
  // It is safe only because the target was just proven to be inside a granted root too.
  return lexical;
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
