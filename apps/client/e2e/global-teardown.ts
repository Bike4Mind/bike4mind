import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Resource } from 'sst';
import { notifyCreditsReport, CREDITS_THRESHOLD } from './helpers/slack';
import { readCreditsData } from './helpers/credits-store';

// Restore allowOpenRegistration to its pre-test value if core.setup enabled it. Runs before
// cleanup (needs the still-valid setup admin token) and only when the marker says it was off,
// so an env where it's intentionally on is never touched.
async function restoreOpenRegistration(baseURL: string): Promise<void> {
  const markerPath = path.resolve(__dirname, '.auth/open-registration-prior.json');
  const corePath = path.resolve(__dirname, '.auth/core-data.json');
  try {
    if (!fs.existsSync(markerPath)) return;
    const { wasOn } = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!wasOn && fs.existsSync(corePath)) {
      const adminToken = JSON.parse(fs.readFileSync(corePath, 'utf8'))?.admin?.accessToken;
      if (adminToken) {
        const r = await fetch(`${baseURL}/api/settings/update`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ key: 'allowOpenRegistration', value: false }),
        });
        console.log(r.ok ? 'Restored allowOpenRegistration=false' : `Restore failed (${r.status})`);
      }
    }
    fs.rmSync(markerPath, { force: true });
  } catch (e) {
    console.warn('Failed to restore allowOpenRegistration:', e);
  }
}

export default async function globalTeardown() {
  dotenv.config({ path: path.resolve(__dirname, '../.env.e2e') });

  // Send credits report only when at least one model exceeds the credit threshold
  const credits = readCreditsData();
  const hasHighCredits = credits.some(e => e.avgCredits !== null && e.avgCredits > CREDITS_THRESHOLD);
  if (hasHighCredits) {
    await notifyCreditsReport(credits);
  }

  const baseURL = process.env.API_URL || 'http://localhost:3000';

  // Restore open registration before cleanup deletes the setup admin whose token we reuse.
  await restoreOpenRegistration(baseURL);

  const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
  if (!secret) {
    console.warn('E2E_CLEANUP_SECRET not set — skipping cleanup');
    return;
  }

  // Scope cleanup to this tester's ID if set (for multi-tester isolation on shared preview builds)
  const testId = process.env.E2E_TEST_ID?.replace(/[^a-zA-Z0-9]/g, '');
  const cleanupUrl = testId
    ? `${baseURL}/api/test/cleanup?testId=${encodeURIComponent(testId)}`
    : `${baseURL}/api/test/cleanup`;

  const response = await fetch(cleanupUrl, {
    method: 'DELETE',
    headers: { 'x-e2e-cleanup-secret': secret },
  });

  // Log results but don't fail the suite
  if (response.ok) {
    const result = await response.json();
    console.log('E2E cleanup:', result.cleaned);
  } else {
    console.warn(`E2E cleanup failed (${response.status}) — test data may remain`);
  }
}
