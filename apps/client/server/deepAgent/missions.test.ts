import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyAgentToolPolicy, type Charter, type DeepAgentStore, type Episode, type Handoff } from '@bike4mind/agents';

// missions.ts touches agentRepository at module scope via @bike4mind/database -
// mock the surface it uses; everything else in that barrel stays untouched.
const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  return { ...original, agentRepository: { findById } };
});

import { enrollMissionForAgent, loadLinkedAgentContext } from './missions';

class FakeStore implements DeepAgentStore {
  charters: Charter[] = [];
  async loadCharter() {
    return null;
  }
  async saveCharter(c: Charter) {
    this.charters.push(c);
    return c;
  }
  async loadHandoff() {
    return null;
  }
  async saveHandoff(h: Handoff) {
    return h;
  }
  async appendEpisode(e: Episode) {
    return e;
  }
  async recentEpisodes() {
    return [];
  }
}

const CEREBO = {
  id: 'b4m-cerebo',
  name: 'Cerebo',
  userId: 'erik',
  systemPrompt: 'You are Cerebo, a go-to-market strategist.',
  allowedTools: ['web_search', 'web_fetch'],
  deniedTools: ['image_generation'],
};

beforeEach(() => findById.mockReset());

describe('enrollMissionForAgent', () => {
  it('derives identity from the agent and records the linkage', async () => {
    findById.mockResolvedValue(CEREBO);
    const store = new FakeStore();
    const result = await enrollMissionForAgent(
      { b4mAgentId: 'b4m-cerebo', callerUserId: 'erik', goal: 'Draft weekly marketing content.' },
      store
    );

    expect(result.charter.identity.name).toBe('Cerebo');
    expect(result.charter.identity.ownerUserId).toBe('erik');
    expect(result.charter.identity.linkedAgentId).toBe('b4m-cerebo');
    expect(result.charter.goal.description).toBe('Draft weekly marketing content.');
    expect(result.missionId).toBe(result.charter.identity.agentId);
    expect(store.charters).toHaveLength(1);
  });

  it("rejects creating a mission on someone else's agent (non-admin)", async () => {
    findById.mockResolvedValue(CEREBO);
    await expect(
      enrollMissionForAgent({ b4mAgentId: 'b4m-cerebo', callerUserId: 'mallory', goal: 'g' }, new FakeStore())
    ).rejects.toThrow(/not your agent/);
  });

  it('allows admins onto any agent, and 404s a missing agent', async () => {
    findById.mockResolvedValue(CEREBO);
    const ok = await enrollMissionForAgent(
      { b4mAgentId: 'b4m-cerebo', callerUserId: 'admin', callerIsAdmin: true, goal: 'g' },
      new FakeStore()
    );
    expect(ok.charter.identity.ownerUserId).toBe('erik'); // owner stays the agent's owner

    findById.mockResolvedValue(null);
    await expect(
      enrollMissionForAgent({ b4mAgentId: 'ghost', callerUserId: 'erik', goal: 'g' }, new FakeStore())
    ).rejects.toThrow(/no agent ghost/);
  });
});

describe('loadLinkedAgentContext', () => {
  it("maps the agent's persona + tool policy, omitting empties", async () => {
    findById.mockResolvedValue(CEREBO);
    const ctx = await loadLinkedAgentContext('b4m-cerebo');
    expect(ctx).toEqual({
      systemPrompt: 'You are Cerebo, a go-to-market strategist.',
      allowedTools: ['web_search', 'web_fetch'],
      deniedTools: ['image_generation'],
    });

    findById.mockResolvedValue({ ...CEREBO, systemPrompt: '', allowedTools: [], deniedTools: undefined });
    expect(await loadLinkedAgentContext('b4m-cerebo')).toEqual({});
  });

  it('returns null when the agent vanished (missions outlive deletion, persona-less)', async () => {
    findById.mockResolvedValue(null);
    expect(await loadLinkedAgentContext('ghost')).toBeNull();
  });
});

describe('applyAgentToolPolicy', () => {
  const profile = ['web_search', 'web_fetch', 'retrieve_knowledge_content', 'math_evaluate'];

  it('passes the profile through untouched for standalone deep agents', () => {
    expect(applyAgentToolPolicy(profile, null)).toEqual(profile);
    expect(applyAgentToolPolicy(profile, undefined)).toEqual(profile);
  });

  it('intersects with the whitelist and subtracts the blacklist', () => {
    expect(applyAgentToolPolicy(profile, { allowedTools: ['web_search', 'math_evaluate', 'not_in_profile'] })).toEqual([
      'web_search',
      'math_evaluate',
    ]);
    expect(applyAgentToolPolicy(profile, { deniedTools: ['web_fetch'] })).toEqual([
      'web_search',
      'retrieve_knowledge_content',
      'math_evaluate',
    ]);
    expect(
      applyAgentToolPolicy(profile, { allowedTools: ['web_search', 'web_fetch'], deniedTools: ['web_fetch'] })
    ).toEqual(['web_search']);
  });

  it('treats an empty whitelist as "no whitelist" (matches AgentModel semantics)', () => {
    expect(applyAgentToolPolicy(profile, { allowedTools: [] })).toEqual(profile);
  });
});
