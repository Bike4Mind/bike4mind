import { describe, it, expect } from 'vitest';
import { AppHomeBuilder, buildErrorHomeView, AppHomeUserContext } from './AppHomeBuilder';

describe('AppHomeBuilder', () => {
  const baseContext: AppHomeUserContext = {
    slackUserId: 'U123456',
    isLinked: true,
  };

  describe('build()', () => {
    it('should return an array of blocks', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it('should include header, dividers, quick actions, and integrations sections', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const blockTypes = blocks.map(b => b.type);
      expect(blockTypes).toContain('header');
      expect(blockTypes).toContain('divider');
      expect(blockTypes).toContain('actions');
      expect(blockTypes.filter(t => t === 'section').length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('header section', () => {
    it('should use appName in header when provided', () => {
      const builder = new AppHomeBuilder({ ...baseContext, appName: 'TestBot' });
      const blocks = builder.build();

      const header = blocks.find(b => b.type === 'header') as any;
      expect(header.text.text).toBe('TestBot');
    });

    it('should default to "Assistant" when appName not provided', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const header = blocks.find(b => b.type === 'header') as any;
      expect(header.text.text).toBe('Assistant');
    });

    it('should show personalized greeting with displayName', () => {
      const builder = new AppHomeBuilder({ ...baseContext, displayName: 'John Doe' });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const welcomeSection = sections[0];
      expect(welcomeSection.text.text).toContain('Welcome, John Doe!');
    });

    it('should show generic greeting without displayName', () => {
      const builder = new AppHomeBuilder({ ...baseContext, appName: 'MyBot' });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const welcomeSection = sections[0];
      expect(welcomeSection.text.text).toContain('Welcome to MyBot!');
    });
  });

  describe('quick actions section', () => {
    it('should include Help and Settings buttons', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      expect(actionsBlock).toBeDefined();

      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
      expect(actionIds).toContain('app_home_help');
      expect(actionIds).toContain('app_home_settings');
    });

    it('should have Help button as primary style when user has no notebooks', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const helpButton = actionsBlock.elements.find((e: any) => e.action_id === 'app_home_help');
      expect(helpButton.style).toBe('primary');
    });

    it('should show Refresh, Help and Settings when linked user has no notebooks', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [],
      });
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
      expect(actionIds).toHaveLength(3);
      expect(actionIds).toContain('app_home_refresh');
      expect(actionIds).toContain('app_home_help');
      expect(actionIds).toContain('app_home_settings');
      expect(actionIds).not.toContain('app_home_create_notebook');
      expect(actionIds).not.toContain('app_home_view_all');
    });

    it('should show all 5 buttons when user has notebooks', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test', lastUpdated: new Date(), messageCount: 1 }],
      });
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
      expect(actionIds).toHaveLength(5);
      expect(actionIds).toContain('app_home_create_notebook');
      expect(actionIds).toContain('app_home_view_all');
      expect(actionIds).toContain('app_home_refresh');
      expect(actionIds).toContain('app_home_help');
      expect(actionIds).toContain('app_home_settings');
    });

    it('should have Refresh button after View All when user has notebooks', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test', lastUpdated: new Date(), messageCount: 1 }],
      });
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const actionIds = actionsBlock.elements.map((e: any) => e.action_id);
      const viewAllIndex = actionIds.indexOf('app_home_view_all');
      const refreshIndex = actionIds.indexOf('app_home_refresh');
      expect(refreshIndex).toBe(viewAllIndex + 1);
    });

    it('should have New Notebook as primary when user has notebooks', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test', lastUpdated: new Date(), messageCount: 1 }],
      });
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const newNotebookBtn = actionsBlock.elements.find((e: any) => e.action_id === 'app_home_create_notebook');
      const helpButton = actionsBlock.elements.find((e: any) => e.action_id === 'app_home_help');
      expect(newNotebookBtn.style).toBe('primary');
      expect(helpButton.style).toBeUndefined();
    });

    it('should include URL on View All button when webAppBaseUrl is provided', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test', lastUpdated: new Date(), messageCount: 1 }],
        webAppBaseUrl: 'https://app.example.com',
      });
      const blocks = builder.build();

      const actionsBlock = blocks.find(b => b.type === 'actions') as any;
      const viewAllBtn = actionsBlock.elements.find((e: any) => e.action_id === 'app_home_view_all');
      expect(viewAllBtn.url).toBe('https://app.example.com/new');
    });
  });

  describe('stats section', () => {
    it('should not show stats when totalNotebooks is 0', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        stats: { totalNotebooks: 0, messagesThisWeek: 5, activeProjects: 2 },
      });
      const blocks = builder.build();

      const contextBlocks = blocks.filter(b => b.type === 'context') as any[];
      const statsBlock = contextBlocks.find(c => c.elements?.[0]?.text?.includes('📊'));
      expect(statsBlock).toBeUndefined();
    });

    it('should show stats with singular text when counts are 1', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        stats: { totalNotebooks: 1, messagesThisWeek: 1, activeProjects: 1 },
      });
      const blocks = builder.build();

      const contextBlocks = blocks.filter(b => b.type === 'context') as any[];
      const statsBlock = contextBlocks.find(c => c.elements?.[0]?.text?.includes('📊'));
      expect(statsBlock).toBeDefined();
      expect(statsBlock.elements[0].text).toContain('1 notebook');
      expect(statsBlock.elements[0].text).toContain('1 message this week');
      expect(statsBlock.elements[0].text).toContain('1 project');
    });

    it('should show stats with plural text when counts are greater than 1', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        stats: { totalNotebooks: 5, messagesThisWeek: 10, activeProjects: 3 },
      });
      const blocks = builder.build();

      const contextBlocks = blocks.filter(b => b.type === 'context') as any[];
      const statsBlock = contextBlocks.find(c => c.elements?.[0]?.text?.includes('📊'));
      expect(statsBlock).toBeDefined();
      expect(statsBlock.elements[0].text).toContain('5 notebooks');
      expect(statsBlock.elements[0].text).toContain('10 messages this week');
      expect(statsBlock.elements[0].text).toContain('3 projects');
    });

    it('should show stats with zero for messages and projects', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        stats: { totalNotebooks: 2, messagesThisWeek: 0, activeProjects: 0 },
      });
      const blocks = builder.build();

      const contextBlocks = blocks.filter(b => b.type === 'context') as any[];
      const statsBlock = contextBlocks.find(c => c.elements?.[0]?.text?.includes('📊'));
      expect(statsBlock).toBeDefined();
      expect(statsBlock.elements[0].text).toContain('0 messages this week');
      expect(statsBlock.elements[0].text).toContain('0 projects');
    });
  });

  describe('integrations status section', () => {
    it('should show GitHub as not connected by default', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const integrationsSection = sections.find(s => s.text.text.includes('GitHub'));
      expect(integrationsSection.text.text).toContain(':x: GitHub not connected');
    });

    it('should show GitHub as connected when hasGitHubConnected is true', () => {
      const builder = new AppHomeBuilder({ ...baseContext, hasGitHubConnected: true });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const integrationsSection = sections.find(s => s.text.text.includes('GitHub'));
      expect(integrationsSection.text.text).toContain(':white_check_mark: GitHub connected');
    });

    it('should show Jira as not connected by default', () => {
      const builder = new AppHomeBuilder(baseContext);
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const integrationsSection = sections.find(s => s.text.text.includes('Jira'));
      expect(integrationsSection.text.text).toContain(':x: Jira not connected');
    });

    it('should show Jira as connected when hasJiraConnected is true', () => {
      const builder = new AppHomeBuilder({ ...baseContext, hasJiraConnected: true });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const integrationsSection = sections.find(s => s.text.text.includes('Jira'));
      expect(integrationsSection.text.text).toContain(':white_check_mark: Jira connected');
    });

    it('should show both integrations connected when both are true', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        hasGitHubConnected: true,
        hasJiraConnected: true,
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const integrationsSection = sections.find(s => s.text.text.includes('GitHub'));
      expect(integrationsSection.text.text).toContain(':white_check_mark: GitHub connected');
      expect(integrationsSection.text.text).toContain(':white_check_mark: Jira connected');
    });
  });

  describe('notebooks section', () => {
    it('should show link account prompt for unlinked users', () => {
      const builder = new AppHomeBuilder({
        slackUserId: 'U123456',
        isLinked: false,
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const linkPrompt = sections.find(s => s.text.text.includes('Link your account'));
      expect(linkPrompt).toBeDefined();
      expect(linkPrompt.text.text).toContain('Connect your Slack to your account');
    });

    it('should show empty state with create button for linked users with no notebooks', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [],
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const emptyState = sections.find(s => s.text.text.includes("don't have any notebooks"));
      expect(emptyState).toBeDefined();
      expect(emptyState.accessory).toBeDefined();
      expect(emptyState.accessory.action_id).toBe('app_home_create_notebook');
      expect(emptyState.accessory.style).toBe('primary');
    });

    it('should display notebooks with URLs when webAppBaseUrl is provided', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test Notebook', lastUpdated: new Date(), messageCount: 5 }],
        webAppBaseUrl: 'https://app.example.com',
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const notebookSection = sections.find(s => s.text.text.includes('Test Notebook'));
      expect(notebookSection).toBeDefined();
      expect(notebookSection.accessory.url).toBe('https://app.example.com/notebooks/nb1');
    });

    it('should display notebooks without URLs when webAppBaseUrl is not provided', () => {
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks: [{ id: 'nb1', name: 'Test Notebook', lastUpdated: new Date(), messageCount: 5 }],
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const notebookSection = sections.find(s => s.text.text.includes('Test Notebook'));
      expect(notebookSection).toBeDefined();
      expect(notebookSection.accessory.url).toBeUndefined();
    });

    it('should limit displayed notebooks to 5', () => {
      const notebooks = Array.from({ length: 10 }, (_, i) => ({
        id: `nb${i}`,
        name: `Notebook ${i}`,
        lastUpdated: new Date(),
        messageCount: i,
      }));
      const builder = new AppHomeBuilder({
        ...baseContext,
        notebooks,
      });
      const blocks = builder.build();

      const sections = blocks.filter(b => b.type === 'section') as any[];
      const notebookSections = sections.filter(s => s.text.text.includes('📓'));
      expect(notebookSections.length).toBe(5);
    });
  });
});

describe('buildErrorHomeView', () => {
  it('should return an array of blocks', () => {
    const blocks = buildErrorHomeView();

    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('should include header, section, and context blocks', () => {
    const blocks = buildErrorHomeView();

    const blockTypes = blocks.map(b => b.type);
    expect(blockTypes).toContain('header');
    expect(blockTypes).toContain('section');
    expect(blockTypes).toContain('context');
  });

  it('should use appName in header when provided', () => {
    const blocks = buildErrorHomeView('CustomApp');

    const header = blocks.find(b => b.type === 'header') as any;
    expect(header.text.text).toBe('CustomApp');
  });

  it('should default to "Assistant" when appName not provided', () => {
    const blocks = buildErrorHomeView();

    const header = blocks.find(b => b.type === 'header') as any;
    expect(header.text.text).toBe('Assistant');
  });

  it('should show error message when provided', () => {
    const blocks = buildErrorHomeView(undefined, 'Test error message');

    const context = blocks.find(b => b.type === 'context') as any;
    expect(context.elements[0].text).toContain('Test error message');
  });

  it('should show default support message when no error provided', () => {
    const blocks = buildErrorHomeView();

    const context = blocks.find(b => b.type === 'context') as any;
    expect(context.elements[0].text).toContain('contact support');
  });

  it('should show error warning in section', () => {
    const blocks = buildErrorHomeView();

    const section = blocks.find(b => b.type === 'section') as any;
    expect(section.text.text).toContain('Something went wrong');
  });
});
