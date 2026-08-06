/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, expect } from '@playwright/test';
import { TIMEOUTS } from './constants';
import { ConsoleTracker } from './helpers/console-tracker';
import { LoginPage } from './pages/LoginPage';
import { seedAuthOnPage, seedFreshRefreshCookie } from './helpers/auth-seed';
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
  loginAsUser: (user: { accessToken: string; refreshToken: string }) => Promise<void>;

  verifyAnswers: (answers: string | string[], options?: VerifyAnswersOptions) => Promise<void>;
};

// playwright.config project names are kebab-case (data-lake); spec-user keys are camelCase (dataLake).
function projectNameToSpecKey(projectName: string): string {
  return projectName.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Email of the spec user backing an authenticated spec project, or null for projects that seed no
 * user (unauthenticated, admin, setup). Returns null rather than throwing when core data is absent
 * so non-spec contexts stay unaffected.
 */
function specUserEmailForProject(projectName: string): string | null {
  try {
    return getTestUsers().specUsers[projectNameToSpecKey(projectName)]?.email ?? null;
  } catch {
    return null;
  }
}

export const test = base.extend<TestFixtures>({
  // Suppress the What's New modal globally - return empty modals so it never renders.
  // This eliminates flaky backdrop-interception failures without relying on timing hacks.
  page: async ({ page, request }, use, testInfo) => {
    await page.route('**/api/modals**', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );

    // Authenticated spec projects seed auth by planting the app's single-use refresh cookie. One
    // token shared across the project (via storageState) is replayed by every test + retry and
    // gets the session revoked by reuse-detection, bouncing later tests to /login. Mint a fresh
    // token per test so the cold-load bootstrap consumes it exactly once. See seedFreshRefreshCookie.
    const email = specUserEmailForProject(testInfo.project.name);
    if (email) {
      await seedFreshRefreshCookie(page, request, email);
    }

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

  loginAsAdmin: async ({ page }, use) => {
    const login = async () => {
      const { admin } = getTestUsers();
      await seedAuthOnPage(page, { accessToken: admin.accessToken, refreshToken: admin.refreshToken });
    };
    await use(login);
  },

  loginAsUser: async ({ page }, use) => {
    const login = async (user: { accessToken: string; refreshToken: string }) => {
      await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
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
