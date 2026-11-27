import { describe, it, expect, vi } from 'vitest';
import { createTavernTools } from '../tavernTools.js';
import type { ITavernService } from '../ITavernService.js';

function createMockService(): ITavernService {
  return {
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    mentionAgent: vi.fn(),
    listQuests: vi.fn(),
    postQuest: vi.fn(),
    deleteQuest: vi.fn(),
    getAgentNotebook: vi.fn(),
    listGates: vi.fn(),
    resolveGate: vi.fn(),
    toggleHeartbeats: vi.fn(),
    triggerHeartbeat: vi.fn(),
    abortHeartbeats: vi.fn(),
  };
}

describe('createTavernTools', () => {
  it('registers exactly the Tavern tools, in order', () => {
    const names = createTavernTools(createMockService()).map(t => t.toolSchema.name);

    expect(names).toEqual([
      'tavern_list_agents',
      'tavern_create_agent',
      'tavern_edit_agent',
      'tavern_delete_agent',
      'tavern_mention',
      'tavern_list_quests',
      'tavern_post_quest',
      'tavern_delete_quest',
      'tavern_read_notebook',
      'tavern_list_gates',
      'tavern_resolve_gate',
      'tavern_toggle_heartbeats',
      'tavern_trigger_heartbeat',
      'tavern_abort_heartbeats',
      'tavern_status',
    ]);
  });

  it('does not register the retired quest-plan workflow tools', () => {
    const names = createTavernTools(createMockService()).map(t => t.toolSchema.name);

    for (const removed of [
      'tavern_get_quest_plan',
      'tavern_update_review_gate',
      'tavern_update_quest_progress',
      'tavern_write_handoff',
    ]) {
      expect(names).not.toContain(removed);
    }
  });
});
