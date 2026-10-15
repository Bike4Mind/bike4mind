import { createHash } from 'node:crypto';
import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthState } from '@shared/auth';

/**
 * Which backend, and whose account, a conversation on disk belongs to.
 *
 * Both halves are required. The environment alone would still show one account's threads to
 * the next person who signs in on this machine, and the account alone would show conversations
 * held against production while the app is pointed at a local server - where the notebooks,
 * artifacts and models they refer to do not exist.
 */
export interface SessionScope {
  /** The resolved endpoint, exactly as AuthState carries it. */
  environmentUrl: string;
  accountId: string;
}

/**
 * The scope key as a single path component: `<endpoint slug>-<digest>`.
 *
 * Anchored, and admits neither a dot nor a separator, so nothing that reaches this can climb
 * out of the sessions directory however it was spelled. Enforced rather than assumed - see
 * `assertScopeKey`.
 */
const SCOPE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Enough of the digest to make a collision a non-event; short enough to stay a readable folder. */
const DIGEST_LENGTH = 12;

/** Keeps the readable half from dominating the name on a long hostname. */
const SLUG_MAX_LENGTH = 32;

/**
 * The endpoint as a stable identity, so one backend keeps one folder across the spellings that
 * mean the same thing: a trailing slash, an upper-case host, an explicit :443.
 *
 * Deliberately no further than that. Two genuinely different strings for one backend - a
 * hostname and its IP, `example.com` and `www.example.com` - stay two scopes, because deciding
 * they are the same means asking the server, and reading conversations off disk has to work
 * with no network at all. It is also already how the credential is bucketed: TokenVault keys
 * tokens by this same URL, so a respelled custom URL makes the user sign in again regardless.
 * Keying sessions the same way keeps a bucket of conversations and the credential that reaches
 * their backend together - the failure mode is "type the URL the way you did last time", never
 * somebody else's threads.
 */
function canonicalEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim();
  }
}

/** The human half of the folder name, for whoever opens the sessions directory. */
function endpointSlug(url: string): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug || 'endpoint';
}

/**
 * The folder one environment-and-account pair stores its conversations in.
 *
 * The digest is what separates two scopes; the slug in front of it only names the folder for a
 * human. A URL and an account id both become part of a path here and both arrive from outside
 * this process - the URL from a text field, the id from a server response - so neither reaches
 * the path in its own characters.
 */
export function sessionScopeKey(scope: SessionScope): string {
  const endpoint = canonicalEndpoint(scope.environmentUrl);
  const digest = createHash('sha256').update(`${endpoint}\n${scope.accountId}`).digest('hex').slice(0, DIGEST_LENGTH);
  return assertScopeKey(`${endpointSlug(endpoint)}-${digest}`);
}

/**
 * Validate a scope key where it becomes a path component, the way `SessionStore.filePath`
 * validates a session id: the derivation above is its only caller today, and a later one that
 * built a key some other way must not be what discovers this was never checked.
 */
export function assertScopeKey(key: string): string {
  if (!SCOPE_KEY_PATTERN.test(key)) throw new Error(`invalid session scope key: ${key}`);
  return key;
}

/**
 * The scope the app is in right now, or null when there is not one.
 *
 * Null whenever either half is unknown - no endpoint, or no identified account - rather than
 * falling back to a shared folder: an empty account id is exactly the case where two people
 * would land in the same one.
 *
 * Read off `user` rather than `status`, because `user` is what AuthService clears at the
 * moments identity stops being known (a sign-out, and the environment switch that precedes a
 * restore), while `status` also passes through `initializing` on its way back to the same
 * account.
 */
export function sessionScopeFor(state: AuthState | null | undefined): SessionScope | null {
  const environmentUrl = state?.environment.url ?? '';
  const accountId = state?.user?.id ?? '';
  if (!environmentUrl || !accountId) return null;
  return { environmentUrl, accountId };
}

/**
 * Move conversations written before storage was scoped into the scope that is signed in now.
 *
 * Every such file predates this change, so nothing on disk records which backend or account it
 * belongs to. The one answer available is "whoever is signed in the first time the app needs a
 * folder after upgrading", which is the account whose conversations they are in every case but
 * a user who switches environment before the sidebar is ever read.
 *
 * Nothing is copied, parsed or deleted: each file is renamed within the same directory tree,
 * which is atomic, so an interruption leaves every file either where it was or where it is
 * going and never half of one. A name already taken in the destination is skipped rather than
 * replaced - POSIX rename would overwrite silently, and an unmigrated file is recoverable
 * where an overwritten transcript is not.
 *
 * Returns the names it moved, for the log line.
 */
export async function migrateLegacySessions(root: string, destination: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const moved: string[] = [];
  for (const name of entries) {
    // Only files, and only finished ones: a `<id>.json.tmp` is a write this app crashed in the
    // middle of, and it is left where it is rather than promoted into a scope.
    if (!name.endsWith('.json')) continue;
    const target = join(destination, name);
    try {
      if (await exists(target)) continue;
      await rename(join(root, name), target);
      moved.push(name);
    } catch {
      // One file that will not move must not strand the rest. It stays where it is, is retried
      // on the next launch, and is still where the user can find it in the meantime.
    }
  }
  return moved;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
