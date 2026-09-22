import { describe, it, expect, vi } from 'vitest';
import type { IAgent, OrchestrationDefaults } from '@bike4mind/common';
import {
  resolveTopLevelProfile,
  pickEffectiveMaxIterations,
  pickEffectiveEnabledTools,
  type ResolvedOrchestrationProfile,
} from './agentExecutor.orchestrationProfile';
// Import the REAL schema (not a local mirror) so this regression test breaks
// if anyone re-adds a soft default to `maxIterations` - mirroring the schema
// would make the test stay green while the bug returns. Pulled from the pure
// schema module so we don't drag the executor's Mongo/AWS deps into the test.
import { StartExecutionSchema } from './agentExecutor.schemas';

const ADMIN_DEFAULTS: OrchestrationDefaults = {
  allowedTools: ['web_search', 'file_read', 'coordinate_task'],
  deniedTools: [],
  maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
  defaultThoroughness: 'medium',
  fallbackModels: [],
  dagEnabled: true,
};

function makeAgent(overrides: Partial<IAgent> = {}): IAgent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'desc',
    triggerWords: [],
    isPublic: false,
    useOwnCredits: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    personality: {
      majorMotivation: '',
      minorMotivation: '',
      flaw: '',
      quirk: '',
      description: '',
    },
    visual: { portraitUrl: '', style: '', generationPrompt: '' },
    identity: {
      gender: 'prefer-not-to-say',
      pronouns: {
        subject: 'they',
        object: 'them',
        possessive: 'their',
        possessiveAdjective: 'theirs',
        reflexive: 'themselves',
      },
    },
    capabilities: [],
    ...overrides,
  } as IAgent;
}

describe('resolveTopLevelProfile', () => {
  it('returns the persisted agent as profile when agentId loads successfully', async () => {
    const loadAgent = vi.fn().mockResolvedValue(
      makeAgent({
        id: 'agent-1',
        name: 'Researcher',
        allowedTools: ['web_search', 'retrieve_knowledge_content'],
        deniedTools: ['delete_file'],
        maxIterations: { quick: 2, medium: 8, very_thorough: 15 },
        defaultThoroughness: 'very_thorough',
      })
    );

    const profile = await resolveTopLevelProfile({
      agentId: 'agent-1',
      loadAgent,
      adminDefaults: ADMIN_DEFAULTS,
      model: 'claude-opus',
    });

    expect(profile.isSynthetic).toBe(false);
    expect(profile.id).toBe('agent-1');
    expect(profile.name).toBe('Researcher');
    expect(profile.allowedTools).toEqual(['web_search', 'retrieve_knowledge_content']);
    expect(profile.deniedTools).toEqual(['delete_file']);
    expect(profile.maxIterations).toEqual({ quick: 2, medium: 8, very_thorough: 15 });
    expect(profile.defaultThoroughness).toBe('very_thorough');
    expect(loadAgent).toHaveBeenCalledWith('agent-1');
  });

  it('falls back to synthetic profile when agentId loads but returns null (unauthorized / missing / deleted)', async () => {
    const loadAgent = vi.fn().mockResolvedValue(null);

    const profile = await resolveTopLevelProfile({
      agentId: 'agent-missing',
      loadAgent,
      adminDefaults: ADMIN_DEFAULTS,
      model: 'claude-opus',
    });

    expect(profile.isSynthetic).toBe(true);
    expect(profile.id).toBe('synthetic:default-orchestration');
    expect(profile.allowedTools).toEqual(['web_search', 'file_read', 'coordinate_task']);
    expect(profile.maxIterations).toEqual({ quick: 3, medium: 10, very_thorough: 20 });
  });

  it('builds synthetic profile when agentId is undefined (the agentless dispatch path)', async () => {
    const loadAgent = vi.fn();

    const profile = await resolveTopLevelProfile({
      agentId: undefined,
      loadAgent,
      adminDefaults: ADMIN_DEFAULTS,
      model: 'claude-sonnet',
    });

    expect(profile.isSynthetic).toBe(true);
    expect(profile.allowedTools).toContain('coordinate_task');
    expect(loadAgent).not.toHaveBeenCalled();
  });

  it('strips coordinate_task from synthetic profile when adminDefaults.dagEnabled is false', async () => {
    const profile = await resolveTopLevelProfile({
      agentId: undefined,
      loadAgent: vi.fn(),
      adminDefaults: { ...ADMIN_DEFAULTS, dagEnabled: false },
      model: 'claude-sonnet',
    });

    expect(profile.allowedTools).not.toContain('coordinate_task');
    expect(profile.allowedTools).toContain('web_search');
  });

  it('uses the schema seed when adminDefaults is null (degraded-mode parity)', async () => {
    const profile = await resolveTopLevelProfile({
      agentId: undefined,
      loadAgent: vi.fn(),
      adminDefaults: null,
      model: 'claude-haiku',
    });

    expect(profile.isSynthetic).toBe(true);
    expect(profile.maxIterations).toEqual({ quick: 5, medium: 15, very_thorough: 30 });
    expect(profile.defaultThoroughness).toBe('medium');
    // Synthetic profile no longer ships an empty toolbelt in degraded mode -
    // it inherits the same conservative seed an admin sees by default.
    expect(profile.allowedTools).toContain('web_search');
    expect(profile.allowedTools).toContain('code_execute');
  });

  it('layers persisted agent orchestration fields over admin defaults (P2 #2)', async () => {
    // Legacy IAgent record: no orchestration fields set. Should land on admin
    // defaults, NOT an empty toolbelt.
    const loadAgent = vi.fn().mockResolvedValue(
      makeAgent({
        id: 'legacy-1',
        name: 'Legacy Agent',
        // No allowedTools / deniedTools / maxIterations / defaultThoroughness.
      })
    );

    const profile = await resolveTopLevelProfile({
      agentId: 'legacy-1',
      loadAgent,
      adminDefaults: ADMIN_DEFAULTS,
      model: 'claude-opus',
    });

    expect(profile.isSynthetic).toBe(false);
    expect(profile.allowedTools).toEqual(['web_search', 'file_read', 'coordinate_task']);
    expect(profile.maxIterations).toEqual({ quick: 3, medium: 10, very_thorough: 20 });
    expect(profile.defaultThoroughness).toBe('medium');
  });

  it('applies dagEnabled: false to the persisted-agent path (P2 #3)', async () => {
    const loadAgent = vi.fn().mockResolvedValue(
      makeAgent({
        id: 'agent-1',
        allowedTools: ['web_search', 'coordinate_task', 'file_read'],
      })
    );

    const profile = await resolveTopLevelProfile({
      agentId: 'agent-1',
      loadAgent,
      adminDefaults: { ...ADMIN_DEFAULTS, dagEnabled: false },
      model: 'claude-opus',
    });

    expect(profile.allowedTools).not.toContain('coordinate_task');
    expect(profile.allowedTools).toContain('web_search');
    expect(profile.allowedTools).toContain('file_read');
  });
});

describe('pickEffectiveMaxIterations', () => {
  const profile: ResolvedOrchestrationProfile = {
    id: 'synthetic:default-orchestration',
    name: 'Default agent',
    allowedTools: [],
    deniedTools: [],
    maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
    defaultThoroughness: 'medium',
    isSynthetic: true,
  };

  it('returns the payload value when defined', () => {
    expect(pickEffectiveMaxIterations(7, profile)).toBe(7);
  });

  it('returns the profile default-thoroughness ceiling when payload is undefined', () => {
    expect(pickEffectiveMaxIterations(undefined, profile)).toBe(10);
  });

  it('respects defaultThoroughness when picking the profile ceiling', () => {
    expect(pickEffectiveMaxIterations(undefined, { ...profile, defaultThoroughness: 'very_thorough' })).toBe(20);
    expect(pickEffectiveMaxIterations(undefined, { ...profile, defaultThoroughness: 'quick' })).toBe(3);
  });

  // P1 regression: drives a real `StartExecutionSchema.parse(...)` (imported
  // from the production module, NOT a local mirror) through the helper. If
  // anyone re-adds `.default(25)` to the schema's `maxIterations`, this test
  // breaks - without it, a mirror-schema test would silently stay green while
  // the bug returns.
  it('a Zod-parsed payload with no maxIterations yields the profile ceiling, not 25 (P1 regression)', () => {
    const parsed = StartExecutionSchema.parse({
      executionId: 'exec-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      query: 'noop',
      model: 'claude-sonnet',
      connectionId: 'conn-1',
    });
    expect(parsed.maxIterations).toBeUndefined();
    expect(pickEffectiveMaxIterations(parsed.maxIterations, profile)).toBe(10);
  });
});

describe('pickEffectiveEnabledTools', () => {
  const profile: ResolvedOrchestrationProfile = {
    id: 'synthetic:default-orchestration',
    name: 'Default agent',
    allowedTools: ['web_search', 'coordinate_task'],
    deniedTools: [],
    maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
    defaultThoroughness: 'medium',
    isSynthetic: true,
  };

  // The payload wins outright for a non-exclusive profile: the client's briefcase-override
  // contract (`resolveDispatchTools`) depends on a pinned selection surviving whatever
  // profile the run resolves, and questmaster v5 nodes ship scoped toolsets the same way.
  it('returns the payload set when non-empty', () => {
    expect(pickEffectiveEnabledTools(['file_read'], profile)).toEqual(['file_read']);
  });

  it('ignores the payload entirely for a profile whose toolset is exclusive', () => {
    const exclusive: ResolvedOrchestrationProfile = { ...profile, toolsetIsExclusive: true };
    expect(pickEffectiveEnabledTools(['web_search'], exclusive)).toEqual(['web_search', 'coordinate_task']);
  });

  it('still subtracts deniedTools from an exclusive toolset', () => {
    const exclusive: ResolvedOrchestrationProfile = {
      ...profile,
      toolsetIsExclusive: true,
      deniedTools: ['coordinate_task'],
    };
    expect(pickEffectiveEnabledTools(['coordinate_task'], exclusive)).toEqual(['web_search']);
  });

  it('falls through to the profile when payload is undefined', () => {
    expect(pickEffectiveEnabledTools(undefined, profile)).toEqual(['web_search', 'coordinate_task']);
  });

  it('treats empty payload arrays as "use profile" (chat dispatch path ships [] when no override)', () => {
    expect(pickEffectiveEnabledTools([], profile)).toEqual(['web_search', 'coordinate_task']);
  });

  it('subtracts profile.deniedTools from the chosen set even when payload pinned tools (P2 #1)', () => {
    const profileWithDenied: ResolvedOrchestrationProfile = {
      ...profile,
      deniedTools: ['delete_file', 'coordinate_task'],
    };
    // Payload tried to enable coordinate_task - admin denylist must still win.
    expect(pickEffectiveEnabledTools(['web_search', 'coordinate_task', 'delete_file'], profileWithDenied)).toEqual([
      'web_search',
    ]);
  });

  it('subtracts profile.deniedTools from the profile default set', () => {
    const profileWithDenied: ResolvedOrchestrationProfile = {
      ...profile,
      allowedTools: ['web_search', 'coordinate_task', 'file_read'],
      deniedTools: ['coordinate_task'],
    };
    expect(pickEffectiveEnabledTools(undefined, profileWithDenied)).toEqual(['web_search', 'file_read']);
  });
});

describe('pickEffectiveEnabledTools - ambient payload union', () => {
  // The agentless chat dispatch. `enabledToolsAreAmbient` says "these are the user's composer
  // picks, not a pinned selection", so the executor unions them onto the profile it just
  // resolved instead of replacing it. Both halves are load-bearing: replacing strips the org's
  // agent-mode toolbelt (`buildSharedTools` only surfaces named tools), and sending nothing
  // strips the user's picks - the bug this whole path exists to fix.
  const synthetic: ResolvedOrchestrationProfile = {
    id: 'synthetic:default-orchestration',
    name: 'Default agent',
    allowedTools: ['web_search', 'retrieve_knowledge_content', 'recharts'],
    deniedTools: [],
    maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
    defaultThoroughness: 'medium',
    isSynthetic: true,
  };

  // The user's picks from the original report - none of them are in the org toolbelt.
  const SMART_TOOLS = ['deep_research', 'chess_engine', 'web_scrape'];

  it('keeps BOTH the user picks and the org toolbelt', () => {
    const result = pickEffectiveEnabledTools(SMART_TOOLS, synthetic, true);
    for (const tool of SMART_TOOLS) expect(result).toContain(tool);
    for (const tool of synthetic.allowedTools) expect(result).toContain(tool);
    expect(result).toEqual([...new Set(result)]);
  });

  it('is exactly the union, with nothing invented beyond it', () => {
    const result = pickEffectiveEnabledTools(SMART_TOOLS, synthetic, true);
    expect(new Set(result)).toEqual(new Set([...SMART_TOOLS, ...synthetic.allowedTools]));
  });

  it('dedupes a pick that is already in the org toolbelt', () => {
    const result = pickEffectiveEnabledTools(['web_search', 'deep_research'], synthetic, true);
    expect(result.filter(t => t === 'web_search')).toHaveLength(1);
  });

  it('still subtracts deniedTools from the union', () => {
    // The payload-proof surface. An ambient payload must not smuggle a denied tool in, and
    // neither must the profile's own allowedTools if an admin denied one of them.
    const profile: ResolvedOrchestrationProfile = {
      ...synthetic,
      deniedTools: ['deep_research', 'recharts'],
    };
    const result = pickEffectiveEnabledTools(SMART_TOOLS, profile, true);
    expect(result).not.toContain('deep_research');
    expect(result).not.toContain('recharts');
    expect(result).toContain('chess_engine');
    expect(result).toContain('web_search');
  });

  it('honors an admin who narrowed allowedTools - the union never re-broadens it', () => {
    // This is what the client-derived union base risked getting wrong: it had to read admin
    // config itself to avoid handing back a tool the admin removed org-wide. Here the base IS
    // the profile the executor resolved, so a narrowed toolbelt is honored by construction.
    const narrowed: ResolvedOrchestrationProfile = { ...synthetic, allowedTools: ['web_search'] };
    const result = pickEffectiveEnabledTools(['deep_research'], narrowed, true);
    expect(new Set(result)).toEqual(new Set(['deep_research', 'web_search']));
    expect(result).not.toContain('recharts');
    expect(result).not.toContain('image_generation');
  });

  it('discards an ambient payload for an exclusive profile, exactly as it does a pinned one', () => {
    // The opti surface. The walk needs its whole toolbelt; a caller's picks narrowing or
    // widening it strands the loop. Behavior is unchanged from the pinned case - what changed
    // is that the executor no longer WARNS about an ambient payload here, because every
    // agentless send ships one and the warn is meant to flag a pinned selection being voided.
    const exclusive: ResolvedOrchestrationProfile = { ...synthetic, toolsetIsExclusive: true };
    expect(pickEffectiveEnabledTools(SMART_TOOLS, exclusive, true)).toEqual(synthetic.allowedTools);
    expect(pickEffectiveEnabledTools(SMART_TOOLS, exclusive, false)).toEqual(synthetic.allowedTools);
  });

  it('REPLACES rather than unions for a persisted-agent profile', () => {
    // A persisted agent's `allowedTools` is a deliberate curation, so ambient chat picks must
    // not widen it. Agentless dispatches always resolve to a synthetic profile, so this gate
    // only matters if a caller ever sets the ambient flag alongside an `agentId` - it bounds
    // that blast radius instead of trusting the caller.
    const persisted: ResolvedOrchestrationProfile = { ...synthetic, isSynthetic: false };
    expect(pickEffectiveEnabledTools(SMART_TOOLS, persisted, true)).toEqual(SMART_TOOLS);
  });

  it('falls through to the profile for an ambient payload that is empty or absent', () => {
    expect(pickEffectiveEnabledTools([], synthetic, true)).toEqual(synthetic.allowedTools);
    expect(pickEffectiveEnabledTools(undefined, synthetic, true)).toEqual(synthetic.allowedTools);
  });

  it('matches what the client-side union produced, for a readable non-empty org toolbelt', () => {
    // Equivalence proof for the refactor: in the case the client could actually handle (admin
    // settings readable, `allowedTools` non-empty), moving the union server-side changes
    // nothing on the wire's behalf. The client used to send
    // `union(picks, allowed - denied)` as a PINNED payload, which the server then replaced the
    // profile with and subtracted `denied` from again.
    const profile: ResolvedOrchestrationProfile = {
      ...synthetic,
      allowedTools: ['web_search', 'recharts', 'coordinate_task'],
      deniedTools: ['coordinate_task', 'delete_file'],
    };
    const denied = new Set(profile.deniedTools);
    const clientSideBase = profile.allowedTools.filter(t => !denied.has(t));
    const legacyClientUnion = [...new Set([...SMART_TOOLS, ...clientSideBase])];
    const legacyResult = pickEffectiveEnabledTools(legacyClientUnion, profile, false);

    const serverSideResult = pickEffectiveEnabledTools(SMART_TOOLS, profile, true);
    expect(new Set(serverSideResult)).toEqual(new Set(legacyResult));
  });

  it('lets the user picks through when an admin emptied allowedTools (deliberate change)', () => {
    // BEHAVIOR CHANGE, called out deliberately. `allowedTools: []` used to suppress the user's
    // picks: the client read it as "agent tools are off org-wide" and sent no payload at all.
    // It is a DEFAULT toolbelt, not a gate - `deniedTools` is the gate, and it is the surface
    // that "wins even over payload-pinned tools". So an emptied `allowedTools` now means "the
    // agent brings nothing of its own", and the user's explicit selection still reaches the
    // run. An admin who wants a tool off org-wide denies it.
    const emptied: ResolvedOrchestrationProfile = { ...synthetic, allowedTools: [] };
    expect(pickEffectiveEnabledTools(SMART_TOOLS, emptied, true)).toEqual(SMART_TOOLS);

    const emptiedAndDenied: ResolvedOrchestrationProfile = {
      ...emptied,
      deniedTools: SMART_TOOLS,
    };
    expect(pickEffectiveEnabledTools(SMART_TOOLS, emptiedAndDenied, true)).toEqual([]);
  });
});
