/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, expect, type Browser, type Page } from '@playwright/test';
import { TIMEOUTS } from './constants';
import { ConsoleTracker } from './helpers/console-tracker';
import { LoginPage } from './pages/LoginPage';
import { buildAuthSuccessUrl, type SpecAuth } from './helpers/auth-seed';
import { NavigationPage } from './pages/NavigationPage';
import { BasePage } from './pages/BasePage';
import { SignupPage } from './pages/SignupPage';
import { ChatPage } from './pages/ChatPage';
import { NotebookPage } from './pages/NotebookPage';
import { ModelSelectorPage } from './pages/ModelSelectorPage';
import { FileUploadPage } from './pages/FileUploadPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProfilePage } from './pages/ProfilePage';
import { AgentsPage } from './pages/AgentsPage';
import { AdminPage } from './pages/AdminPage';
import { TavernPage } from './pages/TavernPage';
import { DataLakePage } from './pages/DataLakePage';
import { SkillsPage } from './pages/SkillsPage';
import { TeamsPage } from './pages/TeamsPage';
import { getTestUsers } from './helpers/test-users';
import { installWafBypass } from './helpers/waf-bypass';
import { bypassTurnstile } from './helpers/turnstile';

type VerifyAnswersOptions = {
  logic?: 'and' | 'or';
  selector?: string;
  timeout?: number;
  matchCase?: boolean;
};

type TestFixtures = {
  consoleTracker: ConsoleTracker;
  loginPage: LoginPage;
  navigationPage: NavigationPage;
  basePage: BasePage;
  signupPage: SignupPage;
  chatPage: ChatPage;
  notebookPage: NotebookPage;
  modelSelector: ModelSelectorPage;
  fileUpload: FileUploadPage;
  projectsPage: ProjectsPage;
  profilePage: ProfilePage;
  agentsPage: AgentsPage;
  adminPage: AdminPage;
  tavernPage: TavernPage;
  dataLakePage: DataLakePage;
  skillsPage: SkillsPage;
  teamsPage: TeamsPage;
  loginAsAdmin: () => Promise<void>;
  loginAsUser: (user: SpecAuth) => Promise<void>;
  /** Mutable per-test identity the page.goto override authenticates as; loginAs* rewrites `current`
   *  so a mid-test user switch takes effect on the next navigation. Null on unauthenticated projects. */
  authState: { current: SpecAuth | null };

  verifyAnswers: (answers: string | string[], options?: VerifyAnswersOptions) => Promise<void>;
};

// playwright.config project names are kebab-case (data-lake); spec-user keys are camelCase (dataLake).
function projectNameToSpecKey(projectName: string): string {
  return projectName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Access token + userId for the user backing an authenticated project, or null for projects that
 *  seed no user (unauthenticated, setup) or before core data exists. The `admin` and `warmup`
 *  projects run off the shared core admin rather than a per-spec user. */
function specAuthForProject(projectName: string): SpecAuth | null {
  try {
    const users = getTestUsers();
    const u =
      projectName === 'admin' || projectName === 'warmup'
        ? users.admin
        : users.specUsers[projectNameToSpecKey(projectName)];
    return u ? { accessToken: u.accessToken, userId: u.userId } : null;
  } catch {
    return null;
  }
}

/** Every seeded user id known at fixture time (core + spec users); empty before core setup runs. */
function knownUserIds(): string[] {
  try {
    const { admin, manager, specUsers } = getTestUsers();
    return [admin, manager, ...Object.values(specUsers)].filter(Boolean).map(u => u.userId);
  } catch {
    return [];
  }
}

/** Fixture-page setup: modals stubbed, cookie consent pre-decided, in-app gotos authenticated as
 *  `getAuth()` through /auth/success. */
async function prepareAppPage(page: Page, getAuth: () => SpecAuth | null): Promise<void> {
  // Suppress the What's New modal globally - return empty modals so it never renders.
  // This eliminates flaky backdrop-interception failures without relying on timing hacks.
  await page.route('**/api/modals**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );

  await bypassTurnstile(page);

  // A fresh browser has no region cookie, so CookieConsentBanner asks, and its fixed bar
  // intercepts clicks on the sidenav and menus. Seed a decision before any app script runs.
  // The key must stay in sync with CONSENT_KEY in app/utils/consentRegion.ts. 'denied' keeps
  // trackers off; a test that sets its own value first wins.
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem('cookie_consent')) localStorage.setItem('cookie_consent', 'denied');
    } catch {
      // Opaque origins (about:blank) have no localStorage.
    }
  });

  // The gears discovery modal opens ~5s after load for any user with an unused gear (every fresh
  // e2e user), landing mid-test behind a click-blocking backdrop. Pre-dismiss it per known user.
  // Key and shape must stay in sync with storageKey/DiscoveryState in lib/gears/discovery.ts.
  // Users minted mid-test aren't known here; BasePage.dismissModals() covers them.
  const authUserId = getAuth()?.userId;
  const userIds = [...new Set([...knownUserIds(), ...(authUserId ? [authUserId] : [])])];
  await page.addInitScript(ids => {
    try {
      for (const id of ids) {
        const key = `gears_discovery_${id}`;
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, JSON.stringify({ lastShownAt: 0, dismissed: true, rotation: 0 }));
        }
      }
    } catch {
      // Opaque origins (about:blank) have no localStorage.
    }
  }, userIds);

  // Authenticated projects: the access token is memory-only and dies on every full load, so a raw
  // goto to a protected route cold-loads unauthenticated and the router guard bounces to /login.
  // Route in-app navigations through /auth/success, which re-seeds the token via the client router
  // without replaying the single-use refresh cookie (whose one shared token got the session
  // revoked) or hitting the rate-limited OTC path. `getAuth` is read per call so a
  // mid-test loginAs* switch is honored; unauthenticated projects (null) pass through.
  const rawGoto = page.goto.bind(page);
  page.goto = (url: string, options?: Parameters<typeof rawGoto>[1]) => {
    const auth = getAuth();
    const wrap = !!auth && url.startsWith('/') && !url.startsWith('/auth/success') && !url.startsWith('/login');
    return rawGoto(wrap ? buildAuthSuccessUrl(url, auth) : url, options);
  };
}

/** A page signed in as `auth` in a browser context of its own, so a second identity never shares
 *  the fixture page's persisted session. */
export async function openPageAs(
  browser: Browser,
  baseURL: string | undefined,
  auth: SpecAuth
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await prepareAppPage(page, () => auth);
  return { page, close: () => context.close() };
}

export const test = base.extend<TestFixtures>({
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; identity derives from the project.
  authState: async ({}, use, testInfo) => {
    // @realauth tests drive the app's real refresh-cookie bootstrap (e.g. the hard-reload guard),
    // so they must NOT be wrapped through /auth/success - null passes their gotos through untouched
    // and they plant their own never-exchanged refresh cookie (see seedAuthStorageState for why).
    const current = testInfo.tags.includes('@realauth') ? null : specAuthForProject(testInfo.project.name);
    await use({ current });
  },

  page: async ({ page, authState }, use) => {
    await installWafBypass(page);
    await prepareAppPage(page, () => authState.current);
    await use(page);
  },

  consoleTracker: async ({ page }, use) => {
    const tracker = new ConsoleTracker(page);
    await use(tracker);
  },

  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  navigationPage: async ({ page }, use) => {
    await use(new NavigationPage(page));
  },

  basePage: async ({ page }, use) => {
    await use(new BasePage(page));
  },

  signupPage: async ({ page }, use) => {
    await use(new SignupPage(page));
  },

  chatPage: async ({ page }, use) => {
    await use(new ChatPage(page));
  },

  notebookPage: async ({ page }, use) => {
    await use(new NotebookPage(page));
  },

  modelSelector: async ({ page }, use) => {
    await use(new ModelSelectorPage(page));
  },

  fileUpload: async ({ page }, use) => {
    await use(new FileUploadPage(page));
  },

  projectsPage: async ({ page }, use) => {
    await use(new ProjectsPage(page));
  },

  profilePage: async ({ page }, use) => {
    await use(new ProfilePage(page));
  },

  agentsPage: async ({ page }, use) => {
    await use(new AgentsPage(page));
  },

  adminPage: async ({ page }, use) => {
    await use(new AdminPage(page));
  },

  tavernPage: async ({ page }, use) => {
    await use(new TavernPage(page));
  },

  dataLakePage: async ({ page }, use) => {
    await use(new DataLakePage(page));
  },

  skillsPage: async ({ page }, use) => {
    await use(new SkillsPage(page));
  },

  teamsPage: async ({ page }, use) => {
    await use(new TeamsPage(page));
  },

  loginAsAdmin: async ({ page, authState }, use) => {
    const login = async () => {
      const { admin } = getTestUsers();
      authState.current = { accessToken: admin.accessToken, userId: admin.userId };
      await page.goto('/'); // wrapped goto re-seeds the token via /auth/success as the new identity
    };
    await use(login);
  },

  loginAsUser: async ({ page, authState }, use) => {
    const login = async (user: SpecAuth) => {
      authState.current = { accessToken: user.accessToken, userId: user.userId };
      await page.goto('/'); // wrapped goto re-seeds the token via /auth/success as the new identity
    };
    await use(login);
  },

  verifyAnswers: async ({ page }, use) => {
    const verify = async (answers: string | string[], options: VerifyAnswersOptions = {}) => {
      const { logic = 'and', selector, timeout = TIMEOUTS.VERIFY_ANSWER, matchCase = false } = options;

      const answerList = Array.isArray(answers) ? answers : [answers];
      const container = selector ? page.locator(selector) : page.locator('body');

      if (logic === 'and') {
        // All answers must be found - use polling to handle multiple matching containers
        for (const answer of answerList) {
          await expect
            .poll(
              async () => {
                const texts = await container.allInnerTexts().catch(() => []);
                const bodyText = texts.join(' ');
                const normalizedBody = matchCase ? bodyText : bodyText.toLowerCase();
                const normalizedAnswer = matchCase ? answer : answer.toLowerCase();
                return normalizedBody.includes(normalizedAnswer);
              },
              { timeout, message: `Expected "${answer}" to appear in response` }
            )
            .toBeTruthy();
        }
      } else {
        // At least one answer must be found - poll until timeout to handle async rendering
        await expect
          .poll(
            async () => {
              // Collect text from ALL matching elements (avoids strict-mode errors with multiple matches)
              const texts = await container.allInnerTexts().catch(() => []);
              const bodyText = texts.join(' ');
              const normalizedBody = matchCase ? bodyText : bodyText.toLowerCase();
              return answerList.some(answer => {
                const normalizedAnswer = matchCase ? answer : answer.toLowerCase();
                return normalizedBody.includes(normalizedAnswer);
              });
            },
            { timeout, message: `Expected one of [${answerList.join(', ')}] to appear in response` }
          )
          .toBeTruthy();
      }
    };
    await use(verify);
  },
});

export { expect };
