import dotenv from 'dotenv';
import path from 'path';
import { Resource } from 'sst';

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

  // Scope to this run's testId so concurrent matrix cells don't wipe each other's freshly-created
  // users. Empty testId (local dev) keeps the unscoped behavior - every -e2e@test.com user is cleared.
  const testId = (process.env.E2E_TEST_ID ?? '').replace(/[^a-zA-Z0-9]/g, '');
  const cleanupUrl = testId
    ? `${baseURL}/api/test/cleanup?testId=${encodeURIComponent(testId)}`
    : `${baseURL}/api/test/cleanup`;

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
