/**
 * A request for a static asset that does not exist must return 404, not the SPA HTML shell.
 * Unauthenticated and browserless: it only uses Playwright's `request` fixture against the base
 * URL, so it needs none of the auth setup and can run against any deployed stage.
 */
import { test, expect } from '@playwright/test';

test.describe('missing static asset', () => {
  test('a nonexistent *.mjs path returns 404, not the SPA shell', async ({ request }) => {
    const response = await request.get('/pdf.worker-0.0.0.min.mjs');
    expect(response.status()).toBe(404);
  });

  test('an extensionless client route still gets the SPA shell', async ({ request }) => {
    const response = await request.get('/some/client/route');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
  });
});
