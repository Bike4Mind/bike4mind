import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';

const TEST_RUN_ID = Date.now().toString().slice(-6);
const AGENT_NAME = `E2E Agent ${TEST_RUN_ID}`;
const RENAMED_AGENT = `E2E Renamed Agent ${TEST_RUN_ID}`;
const PROJECT_NAME = `E2E Agent Project ${TEST_RUN_ID}`;

test.describe('Agents - Navigation, CRUD & Validation', () => {
  test('should navigate, create, edit, validate, and delete an agent', async ({
    page,
    basePage,
    navigationPage,
    chatPage,
    modelSelector,
    verifyAnswers,
    projectsPage,
    agentsPage,
  }) => {
    test.slow();
    await test.step('navigate to agents via sidenav', async () => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await basePage.dismissModals();

      await page.getByTestId('sidenav-nav-agents').click();

      // Verify we landed on the agents page
      await expect(page).toHaveURL(/.*\/agents.*/);

      // SPA route transition shows a full-page loading spinner - wait for it to clear
      // before asserting the heading, otherwise the assertion races against the loader.
      await basePage.waitForLoaderToDisappear('route-loading');

      await expect(page.getByTestId('agent-page-heading')).toBeVisible({
        timeout: TIMEOUTS.NAVIGATION,
      });
    });

    await test.step('create a project for agent testing', async () => {
      await projectsPage.page.goto('/projects');
      await projectsPage.page.waitForLoadState('domcontentloaded');
      await projectsPage.dismissModals();

      await projectsPage.createProject(PROJECT_NAME, 'Project for E2E agent tests');

      await expect(projectsPage.page.getByTestId('project-card-name').filter({ hasText: PROJECT_NAME })).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('create a custom agent', async () => {
      await agentsPage.gotoCreateAgent();

      await agentsPage.createAgent({
        name: AGENT_NAME,
        description: 'An E2E test agent for automated testing',
        projectName: PROJECT_NAME,
        triggerWord: '@e2etest',
      });

      // Verify redirect to agents list or agent view
      await expect(agentsPage.page).toHaveURL(/\/agents/);
    });

    await test.step('view agent details', async () => {
      await agentsPage.gotoAgents();
      await agentsPage.openAgent(AGENT_NAME);

      // Verify agent view page shows correct name
      await expect(agentsPage.page.getByTestId('agent-view-name')).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
    });

    await test.step('edit agent name and description', async () => {
      await agentsPage.gotoAgents();
      await agentsPage.openAgent(AGENT_NAME);

      await agentsPage.editAgent({
        name: RENAMED_AGENT,
        description: 'Updated description for E2E testing',
      });

      // Verify the update persisted - navigate back to list
      await agentsPage.gotoAgents();
      await agentsPage.verifyAgentExists(RENAMED_AGENT);
    });

    await test.step('validate agent in chat', async () => {
      await page.goto('/');
      await page.waitForLoadState('domcontentloaded');
      await basePage.dismissModals();

      // Start a new chat
      await navigationPage.navigateToNewChat();
      await expect(chatPage.chatInput).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
      await modelSelector.selectTextModel('GPT-4.1 Mini');

      // Open the Agents dropdown in the chat toolbar and attach the test agent
      const agentsToolbarBtn = page.getByTestId('session-bottom-container').getByRole('button', { name: 'Agents' });
      await expect(agentsToolbarBtn).toBeVisible({ timeout: TIMEOUTS.ACTION });
      await agentsToolbarBtn.click();

      // Toggle the agent switch in the dropdown to attach it
      const agentMenu = page.getByRole('menu').filter({ hasText: RENAMED_AGENT });
      await expect(agentMenu).toBeVisible({ timeout: TIMEOUTS.ACTION });
      const agentToggle = agentMenu.getByRole('switch');
      await agentToggle.first().click();

      // Close the agents dropdown - wait for menu to disappear before typing so
      // the keyboard event lands on the chat input, not the open dropdown.
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden({ timeout: TIMEOUTS.MODAL });

      // Send a prompt and verify AI responds
      await chatPage.sendMessageAndWaitForResponse('Who wrote Romeo and Juliet?');

      await verifyAnswers(['Shakespeare'], {
        selector: '[data-testid="ai-response"]',
        logic: 'or',
      });
    });

    await test.step('delete the agent', async () => {
      await agentsPage.gotoAgents();
      await agentsPage.openAgent(RENAMED_AGENT);
      await agentsPage.deleteAgentFromView();

      // Verify redirect back to agents list and agent is gone
      await agentsPage.gotoAgents();
      await agentsPage.verifyAgentNotExists(RENAMED_AGENT);
    });

    await test.step('delete the test project', async () => {
      await projectsPage.page.goto('/projects');
      await projectsPage.page.waitForLoadState('domcontentloaded');
      await projectsPage.dismissModals();

      await projectsPage.deleteProject(PROJECT_NAME);

      await expect(projectsPage.page.getByTestId('project-card-name').filter({ hasText: PROJECT_NAME })).toBeHidden({
        timeout: TIMEOUTS.VISIBLE,
      });
    });
  });
});
