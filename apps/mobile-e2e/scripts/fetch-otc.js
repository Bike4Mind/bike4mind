/* global B4M_E2E_SERVER_URL, B4M_E2E_EMAIL, B4M_E2E_CLEANUP_SECRET, http, json, output */
// Fetches the plaintext login one-time code that the server just emailed to the staging test user.
// Only non-production stages serve /api/test/otc-code, and only to callers holding the cleanup secret
// and using a "-e2e@test.com" address. Output is `output.otc`, consumed by subflows/sign-in.yaml.
var base = B4M_E2E_SERVER_URL.replace(/\/+$/, '');
var url = base + '/api/test/otc-code?email=' + encodeURIComponent(B4M_E2E_EMAIL);
var response = http.get(url, { headers: { 'x-e2e-cleanup-secret': B4M_E2E_CLEANUP_SECRET } });
if (!response.ok) {
  throw new Error('otc-code lookup failed with HTTP ' + response.status);
}
var body = json(response.body);
output.otc = String(body.code);
