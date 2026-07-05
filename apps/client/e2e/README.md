# Playwright E2E Tests

End-to-end tests for the Bike4Mind client application using [Playwright](https://playwright.dev/).

## Quick Start

```bash
# From apps/client/
pnpm test:e2e:setup    # Installs Chromium + creates .env.e2e interactively
pnpm test:e2e          # Run all tests
```

If you prefer manual setup:

```bash
# 1. Install browser
npx playwright install chromium --with-deps

# 2. Create environment file
cp .env.e2e.example .env.e2e
# Fill in the required values (see Environment Variables below)

# 3. Run tests
pnpm test:e2e
```

## Manual login on a preview (QA — no Playwright)

If you just need to **sign into a PR preview by hand** (not run the automated suite),
you don't need any of the Playwright setup below. The app is passwordless, and preview
envs have open self-registration **off**, so use the standing seeded accounts that every
preview auto-creates:

| Account | Role |
|---|---|
| `qa-admin-e2e@test.com` | Admin (default credits, admin settings) |
| `qa-user-e2e@test.com` | Regular user |

Steps:

1. Go to `https://app.pr<N>.preview.bike4mind.com/login`, enter the email, click **Continue**.
2. Fetch the one-time code (the `-e2e@test.com` addresses expose it via the gated test endpoint):
   ```bash
   curl -s -H "x-e2e-cleanup-secret: $E2E_CLEANUP_SECRET" \
     "https://app.pr<N>.preview.bike4mind.com/api/test/otc-code?email=qa-admin-e2e@test.com"
   # → {"code":"123456"}
   ```
3. Type the 6-digit code → **Verify Code** → you're in.

`$E2E_CLEANUP_SECRET` is one shared value, the same on every preview — see
[Environment Variables](#environment-variables) for what it is and how to get it.

Notes: codes expire in 10 min and are single-use (use **Resend code** + re-fetch if needed);
there's a 30s cooldown per email and 5 sends / 15 min per IP; only `-e2e@test.com` emails work
with the code endpoint. These seeded accounts exist **only on preview stages** (the seeder refuses
to run anywhere else). Once #9762 (edge-gated open signup) lands, you'll self-register on previews
with your own inbox instead.

## Available Scripts

Run from `apps/client/`:

| Script | Description |
|--------|-------------|
| `pnpm test:e2e:setup` | Interactive setup — installs Chromium and creates `.env.e2e` |
| `pnpm test:e2e` | Run all tests in headless mode |
| `pnpm test:e2e:ui` | Open Playwright UI mode (interactive test runner) |
| `pnpm test:e2e:headed` | Run tests with a visible browser window |
| `pnpm test:e2e:report` | Open the HTML test report from the last run |

You can also pass Playwright CLI flags directly:

```bash
# Run a specific test file
pnpm test:e2e -- auth.spec.ts

# Run tests matching a name pattern
pnpm test:e2e -- -g "should log in"

# Run with a specific number of workers
PW_WORKERS=1 pnpm test:e2e
```

## Environment Variables

Copy `.env.e2e.example` to `.env.e2e` and fill in the values:

| Variable | Required | Description |
|----------|----------|-------------|
| `API_URL` | Yes | Base URL of the app (default: `http://localhost:3000`) |
| `E2E_TEST_ID` | No | Optional prefix for test user isolation (e.g., `alice`). Use when multiple testers run on shared preview builds. |
| `E2E_CLEANUP_SECRET` | Yes* | Shared secret for the `/api/test/*` endpoints (create-user, cleanup, otc-code). **Same value on every preview** — auto-provisioned from the `E2E_CLEANUP_SECRET` GitHub Actions secret on each deploy. Required when running without SST context (staging/preview); falls back to the SST Resource if unset. Get the value from the team secret store, or read it per-stage: `./for-env bike4mind-previews npx sst secret list --stage pr<N> \| grep E2E_CLEANUP_SECRET`. Never commit the literal value. |
| `PW_WORKERS` | No | Number of parallel workers (default: 1) |

## Project Structure

```
e2e/
├── core.setup.ts              # Creates core test users (admin/manager) and seeds auth state
├── global-setup.ts            # Pre-run cleanup of stale test data
├── global-teardown.ts         # Post-run cleanup
├── fixtures.ts                # Custom fixtures (page objects, helpers)
├── constants.ts               # Timeout values (TIMEOUTS.ACTION, etc.)
│
├── .auth/                     # Stored authentication state (gitignored)
│   ├── admin.json             # Admin browser state
│   ├── user.json              # Regular user browser state
│   └── test-users.json        # Test user credentials for API calls
│
├── helpers/
│   ├── api.ts                 # API client (create test users, create/delete resources)
│   ├── auth-seed.ts           # Token-seed auth (writes tokens to localStorage / storageState)
│   ├── test-users.ts          # Test user credential management
│   └── console-tracker.ts     # Console error tracking & filtering
│
├── pages/                     # Page Object Model classes
│   ├── BasePage.ts            # Common utilities (clearStorage, dismissModals, waitForToast)
│   ├── LoginPage.ts           # Login flow
│   ├── SignupPage.ts          # Signup flow
│   ├── NavigationPage.ts      # Sidebar navigation
│   ├── ChatPage.ts            # Chat / AI interactions
│   ├── NotebookPage.ts        # Notebook operations
│   ├── ProjectsPage.ts        # Project CRUD
│   ├── ProfilePage.ts         # User profile
│   ├── AdminPage.ts           # Admin dashboard
│   ├── AgentsPage.ts          # Agents feature
│   ├── FileUploadPage.ts      # File handling
│   └── ModelSelectorPage.ts   # Model selection
│
└── *.spec.ts                  # Test specs (auth, signup, projects, etc.)
```

## Test Projects

The Playwright config defines four projects that run in dependency order:

```
setup → unauthenticated
      → admin
      → chromium
```

| Project | Purpose | Auth State |
|---------|---------|------------|
| **setup** | Creates test users, logs them in, saves browser state | None (creates auth) |
| **unauthenticated** | Login and signup flows | None (tests auth UI) |
| **admin** | Admin-only features (dashboard, settings) | `.auth/admin.json` |
| **chromium** | Main test suite (everything except auth/signup/admin) | `.auth/user.json` |

The `setup` project runs first (serially) and the other three depend on it. This means test users are created once and their browser sessions are reused across all tests.

## Authentication Flow

The app is passwordless — users sign in with a one-time code (OTC) emailed to
them. The E2E suite does **not** drive that UI to authenticate. Instead, setup
**token-seeds** auth: `/api/test/create-user` returns real access/refresh tokens,
and the suite writes them straight into the app's persisted `localStorage` and a
Playwright `storageState` file. No password, no OTC email, no UI round-trip.

The core setup (`core.setup.ts`) and per-spec setups (`helpers/spec-setup.ts`)
run before the tests:

1. **Creates test users** via `/api/test/create-user` with timestamped emails (e.g., `setup-admin-17100000-e2e@test.com`, or `setup-admin-alice-17100000-e2e@test.com` if `E2E_TEST_ID=alice`). The response carries `accessToken` + `refreshToken`.
2. **Configures features** — enables Agents globally (admin setting) and per-user (preferences)
3. **Seeds auth** — `seedAuthStorageState` (in `helpers/auth-seed.ts`) writes the returned tokens into the `access-token-storage` localStorage key and saves the browser's `storageState` to `.auth/`
4. **Saves credentials** to `.auth/*-data.json` (including tokens) for API-based test setup and mid-test user switching
5. **Creates invite code** for the signup spec

For mid-test user switching, `seedAuthOnPage` sets the same localStorage value on
a live page and navigates to `/` to bootstrap the authenticated app. An agent
(Claude Code + Playwright MCP) authenticates the same way — by token-seeding, not
by a password/OTC UI round-trip.

Before setup runs, `global-setup.ts` calls `/api/test/cleanup` to remove stale test users from prior runs. After all tests, `global-teardown.ts` does the same.

### Completing an OTC login/registration in a test (no mailbox needed)

On non-production stages, `GET /api/test/otc-code?email=<addr>` returns the plaintext
code that `/api/otc/send` just emailed — so Playwright (and QA automation) can complete
the passwordless flow without reading a real inbox. Gating: `isE2EEnabled()` (hard-false
on production), the `x-e2e-cleanup-secret` header, and a `-e2e@test.com` email restriction
(it can never reveal a real user's code). Pattern:

```ts
await loginPage.goto();
await loginPage.fillEmail(user.email);           // triggers /api/otc/send
const { code } = await (await request.get(
  `${baseURL}/api/test/otc-code?email=${encodeURIComponent(user.email)}`,
  { headers: { 'x-e2e-cleanup-secret': process.env.E2E_CLEANUP_SECRET! } }
)).json();
await loginPage.fillOtc(code);
await loginPage.submit();
```

**MFA** needs no extra infra: the MFA setup endpoint returns the `totpSecret`, so a test
can enroll, then generate valid codes in-test with `otplib`/`speakeasy`.

The OTC verification logic is also covered by unit tests in `b4m-core/services`
(`sendOTC.test.ts` / `verifyOTC.test.ts`), the endpoint gating by `apps/client/__tests__/otc-code.test.ts`,
and the login UI's error path (wrong code) by `auth.spec.ts`. Authoring the browser
happy-path + MFA specs on top of this is tracked in #9759.

## Writing Tests

### Use page objects and fixtures

Tests use custom fixtures that provide page objects automatically:

```typescript
import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';

test('should create a project', async ({ projectsPage, navigationPage }) => {
  await navigationPage.navigateToProjects();
  await projectsPage.createProject('My Project');
  await expect(projectsPage.projectTitle).toHaveText('My Project', {
    timeout: TIMEOUTS.NAVIGATION,
  });
});
```

### Available fixtures

All page objects are available as fixtures — just destructure them in the test signature:

- `loginPage`, `signupPage`, `navigationPage`, `chatPage`, `notebookPage`
- `projectsPage`, `profilePage`, `adminPage`, `agentsPage`
- `modelSelector`, `fileUpload`, `basePage`

Additional fixtures:
- **`consoleTracker`** — captures `console.error` and page errors (auto-filters noise like ResizeObserver, HMR, etc.)
- **`verifyAnswers(answers, options?)`** — polls the page for AI-generated content with configurable timeout and AND/OR logic

### Use `data-testid` for selectors

Always use `data-testid` attributes, never CSS classes:

```typescript
// ✅ Good
page.getByTestId('submit-btn')

// ❌ Bad
page.locator('.submit-button')
```

### Use timeout constants

Import from `constants.ts` instead of hardcoding timeouts:

```typescript
import { TIMEOUTS } from '../constants';

await expect(element).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });  // 15s
await page.waitForTimeout(TIMEOUTS.UI_SETTLE);                       // 500ms
```

| Constant | Value | Use Case |
|----------|-------|----------|
| `UI_SETTLE` | 500ms | Brief wait for UI to settle |
| `POST_ACTION` | 2s | After a user action |
| `ELEMENT_STATE` | 5s | Element state changes |
| `MODAL` | 8s | Modal appearance |
| `VISIBLE` | 10s | Default assertion timeout |
| `NAVIGATION` | 15s | Page navigation |
| `ACTION` | 30s | Major operations |
| `VERIFY_ANSWER` | 50s | AI streaming responses |
| `AI_RESPONSE` | 120s | AI / image generation |

### API helpers for test setup

Use `helpers/api.ts` to set up test data without going through the UI:

```typescript
import { apiCreateSession, apiDeleteSession } from '../helpers/api';
import { getTestUsers } from '../helpers/test-users';

let sessionId: string;

test.beforeAll(async ({ request }) => {
  // Setup already seeded tokens onto the test users — reuse them, no login needed.
  const { user } = getTestUsers();
  sessionId = await apiCreateSession(request, user.accessToken, 'Test Session');
});

test.afterAll(async ({ request }) => {
  const { user } = getTestUsers();
  await apiDeleteSession(request, user.accessToken, sessionId);
});
```

## CI Integration

E2E tests run automatically on **pull request preview deployments** via GitHub Actions (`.github/workflows/deploy.yml`):

1. After the preview deploys, CI waits for the URL to become healthy
2. Tests run headless with 3 workers against the preview URL
3. Results are posted as a **comment on the PR** with pass/fail counts
4. The **HTML report** is uploaded as a build artifact (`playwright-report-pr<N>`)

In CI, `API_URL` points at the deployment under test. `E2E_CLEANUP_SECRET` is **not** a GitHub secret — it lives only in SST: each `pr{n}` preview self-provisions a fresh random value at deploy time, and every Playwright step runs inside `pnpm sst shell`, so the test client reads `Resource.E2E_CLEANUP_SECRET.value` (the same value the cleanup/create-user API validates against). See issue #251.

## Debugging

### Playwright UI Mode

The most powerful debugging tool. Provides a visual test runner with time-travel, DOM snapshots, and network inspection:

```bash
pnpm test:e2e:ui
```

### Headed Mode

Watch tests run in a real browser:

```bash
pnpm test:e2e:headed
```

### HTML Report

After a test run, view the full report with screenshots and traces:

```bash
pnpm test:e2e:report
```

### Traces

Traces are recorded **on first retry** (configured in `playwright.config.ts`). When a test fails and retries, the trace is saved to `e2e/test-results/` and viewable in the HTML report or at [trace.playwright.dev](https://trace.playwright.dev/).

### Screenshots

Screenshots are captured **on failure** and saved to `e2e/test-results/`. They're also included in the HTML report.

### Run a Single Test

```bash
# By file
pnpm test:e2e -- projects.spec.ts

# By test name
pnpm test:e2e -- -g "should rename a project"

# Single worker for easier debugging
PW_WORKERS=1 pnpm test:e2e -- projects.spec.ts
```
