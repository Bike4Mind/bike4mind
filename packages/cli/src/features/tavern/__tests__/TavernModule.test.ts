import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TavernModule } from '../TavernModule.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import type { QuestPlanResponse } from '../types.js';

function createMockApiClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

describe('TavernModule — /quest command', () => {
  let module: TavernModule;
  let mockApiClient: ApiClient;

  beforeEach(() => {
    mockApiClient = createMockApiClient();
    module = new TavernModule(mockApiClient, vi.fn(), () => []);
  });

  it('registers a /quest command', () => {
    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest');
    expect(questCommand).toBeDefined();
    expect(questCommand!.description).toContain('review');
  });

  it('system prompt section includes quest workflow tools', () => {
    const prompt = module.getSystemPromptSection();
    expect(prompt).toContain('tavern_get_quest_plan');
    expect(prompt).toContain('tavern_update_review_gate');
    expect(prompt).toContain('tavern_update_quest_progress');
    expect(prompt).toContain('tavern_write_handoff');
  });

  it('system prompt section includes session handoff instructions', () => {
    const prompt = module.getSystemPromptSection();
    expect(prompt).toContain('/quest resume');
    expect(prompt).toContain('Session Handoff');
  });

  it('/quest with no subcommand shows usage including resume', () => {
    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    questCommand.execute([]);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('/quest review');
    expect(output).toContain('/quest resume');
    logSpy.mockRestore();
  });

  it('/quest resume without plan_id shows usage', async () => {
    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await questCommand.execute(['resume']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Usage: /quest resume <plan_id>');
    logSpy.mockRestore();
  });

  it('/quest resume displays handoff when present', async () => {
    const mockPlan: QuestPlanResponse = {
      _id: 'plan-123',
      notebookId: 'nb-1',
      goal: 'Build the thing',
      quests: [],
      state: 'active',
      metrics: {
        totalTimeSpent: 3600,
        completionRate: 0.5,
        subQuestsCompleted: 2,
        subQuestsTotal: 4,
      },
      handoff: {
        summary: 'Finished the schema layer',
        nextSteps: ['Implement API routes', 'Add tests'],
        pendingDecisions: ['Which auth strategy?'],
        blockers: ['Waiting on design review'],
        lastUpdatedBy: 'user-1',
        updatedAt: '2026-04-28T12:00:00Z',
      },
    };

    (mockApiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPlan);

    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await questCommand.execute(['resume', 'plan-123']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Build the thing');
    expect(output).toContain('active');
    expect(output).toContain('2/4 sub-quests (50%)');
    expect(output).toContain('Finished the schema layer');
    expect(output).toContain('Implement API routes');
    expect(output).toContain('Add tests');
    expect(output).toContain('Which auth strategy?');
    expect(output).toContain('Waiting on design review');
    logSpy.mockRestore();
  });

  it('/quest resume shows message when no handoff exists', async () => {
    const mockPlan: QuestPlanResponse = {
      _id: 'plan-456',
      notebookId: 'nb-2',
      goal: 'Another quest',
      quests: [],
      state: 'draft',
    };

    (mockApiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPlan);

    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await questCommand.execute(['resume', 'plan-456']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('No handoff found');
    logSpy.mockRestore();
  });

  it('/quest resume omits empty sections from handoff', async () => {
    const mockPlan: QuestPlanResponse = {
      _id: 'plan-789',
      notebookId: 'nb-3',
      goal: 'Minimal handoff plan',
      quests: [],
      state: 'paused',
      handoff: {
        summary: 'Just started',
        nextSteps: [],
        pendingDecisions: [],
        blockers: [],
        lastUpdatedBy: 'user-1',
        updatedAt: '2026-04-28T12:00:00Z',
      },
    };

    (mockApiClient.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPlan);

    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await questCommand.execute(['resume', 'plan-789']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Just started');
    expect(output).not.toContain('Next Steps');
    expect(output).not.toContain('Pending Decisions');
    expect(output).not.toContain('Blockers');
    logSpy.mockRestore();
  });

  it('/quest resume handles API errors gracefully', async () => {
    (mockApiClient.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Not found'));

    const commands = module.getCommands();
    const questCommand = commands.find(c => c.name === 'quest')!;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await questCommand.execute(['resume', 'bad-id']);

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('Error fetching quest plan: Not found');
    logSpy.mockRestore();
  });
});
