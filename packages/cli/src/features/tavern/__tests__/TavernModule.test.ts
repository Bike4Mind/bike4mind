import { describe, it, expect, vi } from 'vitest';
import { TavernModule } from '../TavernModule.js';
import type { ApiClient } from '../../../auth/ApiClient.js';

function createMockApiClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

describe('TavernModule', () => {
  it('registers only the /tavern slash command', () => {
    const module = new TavernModule(createMockApiClient(), vi.fn(), () => []);

    expect(module.getCommands().map(c => c.name)).toEqual(['tavern']);
  });

  it('system prompt section does not advertise the retired quest-plan workflow', () => {
    const prompt = new TavernModule(createMockApiClient(), vi.fn(), () => []).getSystemPromptSection();

    expect(prompt).toContain('tavern_status');
    expect(prompt).not.toContain('tavern_get_quest_plan');
    expect(prompt).not.toContain('tavern_update_review_gate');
    expect(prompt).not.toContain('tavern_update_quest_progress');
    expect(prompt).not.toContain('tavern_write_handoff');
    expect(prompt).not.toContain('/quest');
    expect(prompt).not.toContain('Review Gates');
  });
});
