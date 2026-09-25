import { test, expect } from './fixtures';
import { TIMEOUTS, MONITORED_MODELS } from './constants';
import { type ModelCreditsData } from './helpers/slack';
import { writeCreditsData } from './helpers/credits-store';
import { apiCreateSession, apiDeleteSession, apiRenameSession } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

// Shared with warmup.setup.ts (which warms these before the measured runs). See constants.ts.
const CREDITS_MODELS = MONITORED_MODELS;
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
  // @realauth: exercises hard reload + history nav, which must hit the app's real refresh-cookie
  // bootstrap - so this test opts out of the /auth/success seed (see fixtures.ts authState) and
  // relies on the pristine cookie the setup planted (see seedAuthStorageState).
  test(
    'survives hard reload and history nav on a deep notebook route',
    { tag: '@realauth' },
    async ({ page, request, basePage, consoleTracker }) => {
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
          // Direct nav (projects is earned-nav; the sidenav row may be hidden). goto still
          // pushes a history entry, so the goBack/goForward assertions below hold.
          await page.goto('/projects');
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
    }
  );
});

test.describe('Notebook - Inline location map', () => {
  // The quest fetch is routed to a fixture below, and page.route cannot see a request the service
  // worker answers. The SW's own CSP needs for map tiles are pinned in proxy.test.ts instead.
  test.use({ serviceWorkers: 'block' });

  const PLACES = [
    { id: 'e2e-hotel', name: 'E2E Harbour Hotel', lat: 55.6767, lng: 12.5665, rating: 4.5, reviews: 1706 },
    { id: 'e2e-bistro', name: 'E2E Bistro', lat: 55.6745, lng: 12.5652, rating: 4.6, category: 'Bistro' },
    { id: 'e2e-trattoria', name: 'E2E Trattoria', lat: 55.6738, lng: 12.5689, rating: 4.3, category: 'Italian' },
  ];
  const place = (id: string) => PLACES.find(p => p.id === id)!;
  // Place citables as web_search stores them; the fence can only reference them by id.
  const citables = PLACES.map(p => ({
    id: `place:${p.id}`,
    type: 'web_url',
    title: p.name,
    url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`,
    status: 'complete',
    timestamp: new Date().toISOString(),
    metadata: { sourceSystem: 'web_search', place: p },
  }));
  const fence = JSON.stringify({
    anchor: { id: 'e2e-hotel', name: place('e2e-hotel').name, label: 'Your hotel' },
    places: [
      { id: 'e2e-bistro', name: 'E2E Bistro', note: 'Two minutes on foot.', lat: 1, lng: 1 },
      { id: 'e2e-trattoria', name: 'E2E Trattoria', note: 'Good pasta.' },
      { id: 'e2e-invented', name: 'E2E Invented Place', note: 'Not in the search results.' },
    ],
  });
  const reply = ['Dinner near your hotel:', '', '```b4m_map', fence, '```', '', 'Book ahead on weekends.'].join('\n');
  const TILE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );

  test('renders pins from stored coordinates beside a synced list, where the reply placed it', async ({
    page,
    request,
    basePage,
  }) => {
    const { specUsers } = getTestUsers();
    const token = specUsers.notebook.accessToken;
    const sessionId = await apiCreateSession(request, token);
    const now = new Date().toISOString();
    const quest = {
      id: 'e2e0000000000000000000a1',
      sessionId,
      type: 'message',
      status: 'done',
      prompt: 'Dinner near my hotel?',
      replies: [reply],
      promptMeta: { citables },
      timestamp: now,
      createdAt: now,
      updatedAt: now,
      images: [],
      videos: [],
      fabFileIds: [],
      agentIds: [],
      structuredReplies: [],
      toolResults: [],
      researchModeResults: [],
      navigationIntents: [],
      uiSideEffects: [],
      attachmentNotices: [],
    };

    try {
      await page.route(`**/api/sessions/${sessionId}/chat**`, route =>
        route.fulfill({ json: { data: [quest], hasMore: false } })
      );
      await page.route('https://tile.openstreetmap.org/**', route =>
        route.fulfill({ contentType: 'image/png', body: TILE_PNG })
      );
      const tileRequested = page.waitForRequest(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);

      await page.goto(`/notebooks/${sessionId}`);
      await basePage.dismissModals();

      const map = page.getByTestId('location-map');
      await expect(map).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
      await tileRequested;

      await test.step('anchor and pins come from the citables; an invented id is dropped', async () => {
        await expect(map.getByTestId('location-map-anchor-pin')).toHaveText('Your hotel');
        await expect(map.getByTestId('location-map-pin')).toHaveText(['4.6', '4.3']);
        const rows = map.getByTestId('location-map-row');
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(0)).toContainText('E2E Harbour Hotel');
        await expect(map.getByTestId('location-map-anchor-tag')).toHaveText('Your hotel');
        await expect(map).not.toContainText('E2E Invented Place');
      });

      await test.step('a row keeps its category and note on separate lines', async () => {
        const row = map.getByTestId('location-map-row').nth(1);
        await expect(row.getByTestId('location-map-row-meta')).toHaveText(/4\.6 .* Bistro/);
        await expect(row.getByTestId('location-map-row-note')).toHaveText('Two minutes on foot.');
        const meta = await row.getByTestId('location-map-row-meta').boundingBox();
        const note = await row.getByTestId('location-map-row-note').boundingBox();
        expect(note!.y).toBeGreaterThanOrEqual(meta!.y + meta!.height - 1);
      });

      await test.step('hovering a row highlights its pin; clicking a pin selects its row', async () => {
        const rows = map.getByTestId('location-map-row');
        const pins = map.getByTestId('location-map-pin');
        await rows.nth(2).hover();
        await expect(pins.nth(1)).toHaveCSS('background-color', 'rgb(21, 101, 192)');
        await expect(pins.nth(0)).toHaveCSS('background-color', 'rgb(255, 255, 255)');

        // At this viewport the map's top sits under the header. Leaflet's keyboard handler used to
        // focus the map on mousedown, scrolling the chat mid-click so the click missed the pin.
        await page.mouse.move(0, 0);
        const pinBefore = await pins.nth(0).boundingBox();
        await pins.nth(0).click();
        await expect(rows.nth(1)).toHaveAttribute('data-active', 'true');
        // The active pin scales up slightly; the old focus scroll moved it by a whole pin height.
        expect(Math.abs((await pins.nth(0).boundingBox())!.y - pinBefore!.y)).toBeLessThan(5);
      });

      await test.step('the map sits between the prose around it, with no raw fence text', async () => {
        const before = await page.getByText('Dinner near your hotel:').boundingBox();
        const after = await page.getByText('Book ahead on weekends.').boundingBox();
        const box = await map.boundingBox();
        expect(box!.y).toBeGreaterThan(before!.y);
        expect(after!.y).toBeGreaterThan(box!.y + box!.height - 1);
        await expect(page.getByText('b4m_map')).toHaveCount(0);
        await expect(page.getByText('"places"')).toHaveCount(0);
      });
    } finally {
      await apiDeleteSession(request, token, sessionId).catch(() => {});
    }
  });
});
