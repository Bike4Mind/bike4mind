/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, expect } from '@playwright/test';
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
import { getTestUsers } from './helpers/test-users';

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
 *  seed no user (unauthenticated, setup) or before core data exists. The `admin` project runs off
 *  the shared core admin rather than a per-spec user. */
function specAuthForProject(projectName: string): SpecAuth | null {
  try {
    const users = getTestUsers();
    const u = projectName === 'admin' ? users.admin : users.specUsers[projectNameToSpecKey(projectName)];
    return u ? { accessToken: u.accessToken, userId: u.userId } : null;
  } catch {
    return null;
  }
}

export const test = base.extend<TestFixtures>({
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; identity derives from the project.
  authState: async ({}, use, testInfo) => {
    await use({ current: specAuthForProject(testInfo.project.name) });
  },

  // Suppress the What's New modal globally - return empty modals so it never renders.
  // This eliminates flaky backdrop-interception failures without relying on timing hacks.
  page: async ({ page, authState }, use) => {
    await page.route('**/api/modals**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );

    // Authenticated projects: the access token is memory-only and dies on every full load, so a raw
    // goto to a protected route cold-loads unauthenticated and the router guard bounces to /login.
    // Route in-app navigations through /auth/success, which re-seeds the token via the client router
    // without replaying the single-use refresh cookie (whose one shared token got the session
    // revoked) or hitting the rate-limited OTC path. `authState.current` is read per call so a
    // mid-test loginAs* switch is honored; unauthenticated projects (current === null) pass through.
    const rawGoto = page.goto.bind(page);
    page.goto = (url: string, options?: Parameters<typeof rawGoto>[1]) => {
      const auth = authState.current;
      const wrap = !!auth && url.startsWith('/') && !url.startsWith('/auth/success') && !url.startsWith('/login');
      return rawGoto(wrap ? buildAuthSuccessUrl(url, auth) : url, options);
    };

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
