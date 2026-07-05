import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { apiCreateSession, apiRenameSession, apiCreateFile } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

const TEST_RUN_ID = Date.now().toString().slice(-6);
const PROJECT_NAME = `E2E Project ${TEST_RUN_ID}`;
const RENAMED_PROJECT = `E2E Renamed ${TEST_RUN_ID}`;
const TEST_NOTEBOOK_NAME = 'E2E France Notebook';
const TEST_FILE_NAME = 'recipe';

test.describe('Projects - Navigation', () => {
  test('should navigate to projects via sidenav', async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await page.getByTestId('sidenav-nav-projects').click();

    await expect(page).toHaveURL(/.*\/projects.*/);
    await expect(page.getByTestId('new-project-btn')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  });
});

test.describe('Projects - CRUD & Management', () => {
  test('should perform full project lifecycle', async ({
    request,
    projectsPage,
    chatPage,
    modelSelector,
    verifyAnswers,
    loginAsUser,
  }) => {
    test.setTimeout(5 * TIMEOUTS.TEST);

    await test.step('setup preconditions', async () => {
      const { user } = getTestUsers();

      // Create a named session so the "add notebook" step has data to work with
      const preconditionSessionId = await apiCreateSession(request, user.accessToken);
      await apiRenameSession(request, user.accessToken, preconditionSessionId, TEST_NOTEBOOK_NAME);

      // Create a file so the "add file via file browser" step has data to work with
      await apiCreateFile(request, user.accessToken, {
        fileName: `${TEST_FILE_NAME}.txt`,
        content: 'Sinigang recipe: pork, tamarind, tomatoes, onions, kangkong.',
      });
    });

    await test.step('create a new project', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.createProject(PROJECT_NAME, 'A test project for E2E automation');

      await expect(projectsPage.page.getByTestId('project-card-name').filter({ hasText: PROJECT_NAME })).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('rename a project', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.renameProject(PROJECT_NAME, RENAMED_PROJECT);

      await expect(
        projectsPage.page.getByTestId('project-card-name').filter({ hasText: RENAMED_PROJECT }).first()
      ).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    });

    await test.step('add notebook to project', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('Notebooks');
      await projectsPage.addNotebook(TEST_NOTEBOOK_NAME);
    });

    await test.step('add file to project via file browser', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('Project Files');
      await projectsPage.addFileViaFileBrowser(TEST_FILE_NAME);
      await projectsPage.waitForToast('Files added to project successfully');
    });

    await test.step('add member to project', async () => {
      const { manager } = getTestUsers();
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('Members');
      await projectsPage.addMember(manager.email);
    });

    await test.step('add system prompt to project', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('System Prompts');
      await projectsPage.addSystemPromptViaFileBrowser(TEST_FILE_NAME);
    });

    await test.step('validate project sharing as invited member', async () => {
      const { manager, user } = getTestUsers();

      // Switch to manager (the invited member) and accept the project invite
      await projectsPage.clearAllStorage();
      await loginAsUser(manager);
      await projectsPage.openInbox();
      await projectsPage.acceptProjectInvite();
      await projectsPage.closeInboxDrawer();

      // Verify the shared project content is visible to the invited member
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.validateSharedProjectContent(TEST_NOTEBOOK_NAME);

      // Switch back to the original projects user for the remaining steps
      await projectsPage.clearAllStorage();
      await loginAsUser(user);
      await projectsPage.gotoProjects();
    });

    await test.step('create notebook in project with AI response', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('Notebooks');
      await projectsPage.createNotebookInProject();

      await modelSelector.selectTextModel('GPT-4.1 Mini');
      await chatPage.sendMessageAndWaitForResponse('What is the recipe for Sinigang?');

      await verifyAnswers(['tamarind', 'sinigang', 'pork'], {
        selector: '[data-testid="ai-response"]',
        logic: 'or',
      });
    });

    await test.step('view system prompt', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('System Prompts');
      await projectsPage.viewSystemPrompt();

      await expect(projectsPage.page.getByTestId('knowledge-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });

      await projectsPage.closeModal();
    });

    await test.step('delete system prompt', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.openProject(RENAMED_PROJECT);
      await projectsPage.clickTab('System Prompts');
      await projectsPage.deleteSystemPrompt();
    });

    await test.step('delete the project', async () => {
      await projectsPage.gotoProjects();
      await projectsPage.deleteProject(RENAMED_PROJECT);

      await expect(projectsPage.page.getByTestId('project-card-name').filter({ hasText: RENAMED_PROJECT })).toBeHidden({
        timeout: TIMEOUTS.VISIBLE,
      });
    });
  });
});
