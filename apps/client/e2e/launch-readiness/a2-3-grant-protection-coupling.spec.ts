import { test, expect } from '../fixtures';
import { guardLaunchReadiness, canChangeSettings, isSingleWorkerRun, SETTINGS_WRITE_SKIP } from './guard';
import { adminToken, apiUrl, liveSetting, readStoredSettings, restoreSettings, withSettings } from './support';

guardLaunchReadiness();

const LARGE_FIRST_TRANCHE = 1_000_000;

test.describe('A2.3 protective settings tied to grant size', () => {
  test('A2.3 a large first tranche cannot be saved while the signup risk policy is off', async ({ request }) => {
    test.skip(!canChangeSettings(), SETTINGS_WRITE_SKIP);
    test.skip(
      !isSingleWorkerRun(),
      'Can briefly set a large first tranche, which a concurrent signup would receive, so it runs only in a single-worker run'
    );
    test.fail(
      true,
      'Recorded as an expected failure until the setting save enforces the coupling between grant size and the protective settings'
    );

    const policy = await liveSetting<{ enabled: boolean }>(request, 'signupGrantRiskPolicy');
    const prior = await readStoredSettings(request, ['signupGrantInitialCredits']);
    await withSettings(request, policy.enabled ? { signupGrantRiskPolicy: { enabled: false } } : {}, async () => {
      let saved = false;
      try {
        const res = await request.put(`${apiUrl()}/api/settings/update`, {
          headers: { Authorization: `Bearer ${adminToken()}` },
          data: { key: 'signupGrantInitialCredits', value: LARGE_FIRST_TRANCHE },
        });
        saved = res.ok();
        expect(res.status(), 'the save is refused as a client error').toBeGreaterThanOrEqual(400);
        expect(res.status()).toBeLessThan(500);
      } finally {
        if (saved) await restoreSettings(request, prior, ['signupGrantInitialCredits']);
      }
    });
  });
});
