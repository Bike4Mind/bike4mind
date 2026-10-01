import { z } from 'zod';

/**
 * What the lake GitHub connect carries across its GitHub round-trips, in sessionStorage (same tab,
 * survives the redirects). Holds nothing secret: the signed `state` is what the server trusts.
 *
 * - `dataLakeId`: where to land the user once the connection completes.
 * - `authorizeUrl`: needed when GitHub returns from the install with `installation_id` but no
 *   `code` (the App was already installed on that account), see buildGitHubLakeConnectUrls.
 * - `installationId`: remembered across that authorize bounce, whose return carries only `code`.
 */
const handoffSchema = z.object({
  dataLakeId: z.string().min(1),
  authorizeUrl: z.url(),
  installationId: z.number().int().positive().optional(),
});

export type GitHubLakeConnectHandoff = z.infer<typeof handoffSchema>;

const STORAGE_KEY = 'b4m:github-lake-connect';

export function saveGitHubLakeConnectHandoff(handoff: GitHubLakeConnectHandoff): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff));
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
