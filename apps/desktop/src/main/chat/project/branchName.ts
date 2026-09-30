import { createHash } from 'node:crypto';

/**
 * Branch names for work a session starts on another session's behalf.
 *
 * A spawned session that is to be isolated needs a branch of its OWN, because a worktree is
 * keyed on its branch: handed the parent's, it would adopt the parent's checkout. So a name has
 * to come from somewhere, and deriving one silently from the session title is fragile - titles
 * are generated, get renamed, and may not slug to anything legal. What is here is therefore a
 * SUGGESTION: the approval card prefills it, shows it, and lets the user replace it before
 * anything is created.
 */

/** Namespaces agent-started branches, so they read as such in `git branch` and in the container. */
const PREFIX = 'agent/';

/** Long enough to stay readable as a folder name, short enough not to swamp the card. */
const MAX_SLUG = 40;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
}

/**
 * A branch to offer for a spawned session, from its title if it has one and its prompt if not.
 *
 * The fallback carries a digest of the prompt rather than a bare word: a constant fallback would
 * collide with itself the second time a title failed to slug, and a collision is refused outright
 * rather than resolved, so it would be a dead end the user had to notice and edit their way out of.
 */
export function suggestBranchName(title: string | undefined, prompt: string): string {
  const slug = slugify(title ?? '') || slugify(prompt);
  if (slug) return `${PREFIX}${slug}`;
  return `${PREFIX}task-${createHash('sha1').update(prompt).digest('hex').slice(0, 6)}`;
}

/**
 * Whether git would accept this as a branch name.
 *
 * Checked here rather than left to `git branch` because the failure has to be reported before
 * anything is created, and `git check-ref-format` would be a subprocess on a path that is
 * already several. The rules are git's own (githooks(5) "check-ref-format"), minus the ones a
 * name typed into a text field cannot hit.
 */
export function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  if (/[\s~^:?*[\\]/.test(branch)) return false;
  if (/(^|\/)[.]|[.]$|\.\.|@\{|\.lock($|\/)/.test(branch)) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('//')) return false;
  if (branch === '@' || branch.endsWith('/')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(branch);
}
