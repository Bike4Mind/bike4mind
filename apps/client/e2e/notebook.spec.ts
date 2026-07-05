import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { type ModelCreditsData } from './helpers/slack';
import { writeCreditsData } from './helpers/credits-store';
import { apiCreateSession, apiDeleteSession, apiRenameSession } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

// Update these when monitored models change - names must match the model selector exactly
const CREDITS_MODELS = ['Claude 4.7 Opus', 'GPT-5.5'];
const RUNS_PER_MODEL = 2;
const CREDITS_PROMPT = 'What is the capital of France?';

function buildCreditsSummary(
  runs: Array<{ model: string; duration: number; credits: number | null }>
): ModelCreditsData[] {
  return CREDITS_MODELS.map(model => {
    const modelRuns = runs.filter(r => r.model === model);
    const successful = modelRuns.filter(r => r.duration > 0);
    const avgDuration =
      successful.length > 0
        ? (successful.reduce((sum, r) => sum + r.duration, 0) / successful.length).toFixed(2)
        : null;
    const creditsRuns = modelRuns.filter(r => r.credits !== null);
    const avgCredits =
      creditsRuns.length > 0
        ? Math.round(creditsRuns.reduce((sum, r) => sum + (r.credits ?? 0), 0) / creditsRuns.length)
        : null;
    return {
      model,
      avgCredits,
      avgDuration: avgDuration ? `${avgDuration} secs.` : null,
      successRate: `${successful.length}/${RUNS_PER_MODEL}`,
    };
  });
}

// serial mode pins this describe to one worker so module-scoped allRuns stays visible;
// without it a higher PW_WORKERS would make afterAll write incomplete data.
test.describe.configure({ mode: 'serial' });

test.describe('Notebook - AI Credits and Timing', () => {
  const allRuns: Array<{ model: string; duration: number; credits: number | null }> = [];

  for (const model of CREDITS_MODELS) {
    test.describe(`Model: ${model}`, () => {
      for (let run = 1; run <= RUNS_PER_MODEL; run++) {
        test(`run ${run} — measure response time and credits`, async ({ page, basePage, chatPage, modelSelector }) => {
          test.slow();
          await page.goto('/');
          await basePage.dismissModals();
          await modelSelector.selectTextModel(model);

          const { durationSecs, credits } = await chatPage.sendMessageAndMeasure(CREDITS_PROMPT);
          allRuns.push({ model, duration: durationSecs, credits });

          // Write after every run so credits.json exists even if afterAll is skipped
          // (e.g. when Playwright's globalTimeout fires and kills the worker mid-suite).
          writeCreditsData(buildCreditsSummary(allRuns));

          console.log(`[${model}] Run ${run}: ${durationSecs.toFixed(2)}s, credits: ${credits ?? 'n/a'}`);
          // Per-run Slack alerts intentionally removed - a single consolidated credits
          // report is sent once after the whole suite completes (see global-teardown.ts).
        });
      }
    });
  }

  test.afterAll(async () => {
    for (const entry of buildCreditsSummary(allRuns)) {
      expect.soft(entry.avgCredits, `Used Credit chip is missing for ${entry.model}!`).not.toBeNull();
    }
  });
});

test.describe('Notebook CRUD', () => {
  test('should create, rename, tag, and delete a notebook', async ({
    page,
    basePage,
    navigationPage,
    chatPage,
    modelSelector,
    verifyAnswers,
    notebookPage,
  }) => {
    test.slow();

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await test.step('create a notebook via prompt', async () => {
      await navigationPage.navigateToNewChat();
      await modelSelector.selectTextModel('GPT-4.1 Mini');

      await chatPage.sendMessageAndWaitForResponse('What is the capital of France?');

      await verifyAnswers('Paris', { selector: '[data-testid="ai-response"]' });
    });

    await test.step('rename a notebook', async () => {
      await notebookPage.selectFirstSession();
      await notebookPage.renameSession('Renamed Notebook');

      // Verify the name changed in sidebar (use filter instead of first() to avoid parallel worker interference)
      await expect(
        notebookPage.page.getByTestId('sidenav-item-session-btn').filter({ hasText: 'Renamed Notebook' })
      ).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    });

    await test.step('add tags to a notebook', async () => {
      await notebookPage.openSessionInfo();
      await notebookPage.addTag('automation');
      await notebookPage.closeSessionInfo();
    });

    await test.step('delete a notebook', async () => {
      await notebookPage.deleteSession();
    });
  });
});

test.describe('Notebook - Router resilience', () => {
  // Guards against TanStack Router / React Query regressions on deep-route reload
  // and browser history navigation - the surface most likely to break on router/query upgrades.
  test('survives hard reload and history nav on a deep notebook route', async ({
    page,
    request,
    basePage,
    consoleTracker,
  }) => {
    const NOTEBOOK_NAME = `E2E Router ${Date.now().toString().slice(-6)}`;
    const { specUsers } = getTestUsers();
    const token = specUsers.notebook.accessToken;

    const sessionId = await apiCreateSession(request, token);
    await apiRenameSession(request, token, sessionId, NOTEBOOK_NAME);

    try {
      const deepUrl = `/notebooks/${sessionId}`;
      const sidebarItem = page.getByTestId('sidenav-item-session-btn').filter({ hasText: NOTEBOOK_NAME });

      await test.step('deep-link directly to the notebook', async () => {
        await page.goto(deepUrl);
        await page.waitForLoadState('domcontentloaded');
        await basePage.dismissModals();
        await expect(sidebarItem).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
      });

      await test.step('hard reload preserves route and rehydrates sidebar query', async () => {
        consoleTracker.clear();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/notebooks/${sessionId}`));
        await expect(sidebarItem).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
      });

      await test.step('back/forward navigate between notebook and projects', async () => {
        await page.getByTestId('sidenav-nav-projects').click();
        await expect(page).toHaveURL(/\/projects/);

        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/notebooks/${sessionId}`));
        await expect(sidebarItem).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });

        await page.goForward();
        await expect(page).toHaveURL(/\/projects/);
        await expect(page.getByTestId('new-project-btn')).toBeVisible({
          timeout: TIMEOUTS.NAVIGATION,
        });
      });

      const errors = consoleTracker.getErrors();
      expect(errors, `Unexpected console errors: ${JSON.stringify(errors, null, 2)}`).toHaveLength(0);
    } finally {
      await apiDeleteSession(request, token, sessionId).catch(() => {});
    }
  });
});
