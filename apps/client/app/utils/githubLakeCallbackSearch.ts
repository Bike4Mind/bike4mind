/** Where the data-lake GitHub App returns the browser (its Callback URL). Must match the GitHub App settings. */
export const GITHUB_LAKE_CALLBACK_PATH = '/data-lakes/github/callback';

let bootSearch: string | null = null;

/**
 * Snapshot the callback's query string exactly as GitHub sent it.
 *
 * MUST run at module load, before createRouter: on its first resolve the router JSON-parses every
 * search value and writes the URL back, so `installation_id=42` becomes `installation_id=%2242%22`
 * and an all-digit OAuth `code` loses precision before any component can read it. GitHub's return
 * is always a full page load, so the snapshot taken here is the one that matters.
 */
export function captureGitHubLakeCallbackSearch(): void {
  if (typeof window === 'undefined') return;
  bootSearch = window.location.pathname === GITHUB_LAKE_CALLBACK_PATH ? window.location.search : null;
}

/** GitHub's untouched query string when this page load landed on the callback, else null. */
export function getGitHubLakeCallbackBootSearch(): string | null {
  return bootSearch;
}
