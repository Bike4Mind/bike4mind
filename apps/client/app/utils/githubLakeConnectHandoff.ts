import { z } from 'zod';
import { buildRedirectTo } from './authRedirect';
import { GITHUB_LAKE_CALLBACK_PATH } from './githubLakeCallbackSearch';

/**
 * What the lake GitHub connect carries across the redirect to GitHub and back, in sessionStorage
 * (same tab, survives the round-trip). Holds nothing secret: the signed `state` embedded in the
 * authorize URL is what the server trusts, and the user's GitHub token never reaches the browser -
 * the server holds it, keyed by an HttpOnly nonce cookie, for the repository picker to read.
 *
 * `dataLakeId`: where to land the user (and reopen the repository picker) once GitHub returns.
 * `returnPath`: the page the connect started from, to navigate back to. Untrusted on read (storage
 * is user-editable), so the callback re-sanitizes it; absent in handoffs saved before it existed.
 */
const handoffSchema = z.object({
  dataLakeId: z.string().min(1),
  returnPath: z.string().optional(),
});

export type GitHubLakeConnectHandoff = z.infer<typeof handoffSchema>;

const STORAGE_KEY = 'b4m:github-lake-connect';

/** Records the current page as `returnPath`, so every caller returns the user to where they started. */
export function saveGitHubLakeConnectHandoff(handoff: Omit<GitHubLakeConnectHandoff, 'returnPath'>): void {
  const { pathname, search, hash } = window.location;
  const returnPath = pathname === GITHUB_LAKE_CALLBACK_PATH ? undefined : buildRedirectTo(pathname, search, hash);
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...handoff, returnPath }));
}

/** The pending handoff, or null when there is none or it does not parse (a stale or foreign value). */
export function readGitHubLakeConnectHandoff(): GitHubLakeConnectHandoff | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = handoffSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // storage blocked, or not JSON: treat exactly like a value that fails the schema
  }
}

/** Never throws: the callback clears on every exit, and a blocked storage has nothing to clear. */
export function clearGitHubLakeConnectHandoff(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: nothing was saved, so there is nothing to clear
  }
}
