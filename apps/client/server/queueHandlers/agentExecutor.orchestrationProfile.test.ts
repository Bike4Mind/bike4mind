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

  it('returns the payload set when non-empty', () => {
    expect(pickEffectiveEnabledTools(['file_read'], profile)).toEqual(['file_read']);
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
