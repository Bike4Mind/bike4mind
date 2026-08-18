import dotenv from 'dotenv';
import path from 'path';
import { Resource } from 'sst';

// Age cutoff for the orphan sweep, in minutes. 6h is far above the longest CI run
// (ai-latency cells allow 90 min) so a concurrent suite is never in range.
const STALE_SWEEP_MINUTES = 360;

/**
 * Cleans up stale e2e data from runs that failed before global-teardown ran,
 * so `-e2e@test.com` users don't accumulate over time.
 */
export default async function globalSetup() {
  // Load .env.e2e explicitly - globalSetup may run before config's dotenv applies
  dotenv.config({ path: path.resolve(__dirname, '../.env.e2e') });

  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;

  if (!secret) {
    throw new Error(
      'E2E_CLEANUP_SECRET is not set.\n' +
        'Local: run `sst secret set E2E_CLEANUP_SECRET <value> --stage local`\n' +
        'CI: set it as a GitHub Actions secret.'
    );
  }

  // Scope to this run's testId so concurrent runs don't wipe each other's freshly-created users.
  // CI always sets a per-run id (.github/workflows/e2e-run.yml); an empty testId is the local-dev
  // fallback only, and there it keeps the unscoped behavior - every -e2e@test.com user is cleared.
  const testId = (process.env.E2E_TEST_ID ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const params = new URLSearchParams();
  if (testId) params.set('testId', testId);
  // A per-run scope never matches a previous run's leftovers, so also ask for the aged sweep to
  // collect users orphaned by runs that died before teardown. The endpoint floors the window well
  // above the longest possible run, so this can never touch a suite that is still going.
  params.set('staleMinutes', String(STALE_SWEEP_MINUTES));
  const cleanupUrl = `${baseURL}/api/test/cleanup?${params.toString()}`;

  const response = await fetch(cleanupUrl, {
    method: 'DELETE',
    headers: { 'x-e2e-cleanup-secret': secret },
  });

  if (response.ok) {
    const result = await response.json();
    if (result.cleaned?.users > 0) {
      console.log('Pre-run cleanup removed stale e2e data:', result.cleaned);
    }
  } else {
    console.warn(`Pre-run cleanup failed (${response.status}) — continuing anyway`);
  }
}
