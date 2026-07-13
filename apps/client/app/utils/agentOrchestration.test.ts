import { describe, it, expect } from 'vitest';
import type { IAgent, OrchestrationDefaults } from '@bike4mind/common';
import { hasOrchestrationFields, pickOrchestrationAgent, buildDefaultOrchestrationProfile } from './agentOrchestration';

const baseAgent = { id: 'a1', name: 'agent-1' } as unknown as IAgent;

describe('hasOrchestrationFields', () => {
  it('returns false for a bare agent with no orchestration fields', () => {
    expect(hasOrchestrationFields(baseAgent)).toBe(false);
  });

  it('returns true when any maxIterations bucket is non-zero', () => {
    expect(
      hasOrchestrationFields({ ...baseAgent, maxIterations: { quick: 3, medium: 0, very_thorough: 0 } } as IAgent)
    ).toBe(true);
    expect(
      hasOrchestrationFields({ ...baseAgent, maxIterations: { quick: 0, medium: 5, very_thorough: 0 } } as IAgent)
    ).toBe(true);
    expect(
      hasOrchestrationFields({ ...baseAgent, maxIterations: { quick: 0, medium: 0, very_thorough: 7 } } as IAgent)
    ).toBe(true);
  });

  it('returns false when maxIterations exists but all buckets are zero', () => {
    expect(
      hasOrchestrationFields({ ...baseAgent, maxIterations: { quick: 0, medium: 0, very_thorough: 0 } } as IAgent)
    ).toBe(false);
  });

  it('returns true when allowedTools is non-empty', () => {
    expect(hasOrchestrationFields({ ...baseAgent, allowedTools: ['web_search'] } as IAgent)).toBe(true);
  });

  it('returns false when allowedTools is an empty array', () => {
    expect(hasOrchestrationFields({ ...baseAgent, allowedTools: [] } as IAgent)).toBe(false);
  });

  it('returns true when deniedTools is non-empty', () => {
    expect(hasOrchestrationFields({ ...baseAgent, deniedTools: ['shell'] } as IAgent)).toBe(true);
  });

  it('returns true when defaultThoroughness is set', () => {
    expect(hasOrchestrationFields({ ...baseAgent, defaultThoroughness: 'medium' } as IAgent)).toBe(true);
  });
});

describe('pickOrchestrationAgent', () => {
  it('returns null for an empty list', () => {
    expect(pickOrchestrationAgent([])).toBeNull();
  });

  it('returns null when no mentioned agent is orchestration-enabled', () => {
    expect(pickOrchestrationAgent([baseAgent, { ...baseAgent, id: 'a2' } as IAgent])).toBeNull();
  });

  it('returns the first orchestration-enabled agent (multi-agent dispatch out of scope)', () => {
    const a1 = baseAgent;
    const a2 = { ...baseAgent, id: 'a2', allowedTools: ['web_search'] } as IAgent;
    const a3 = { ...baseAgent, id: 'a3', defaultThoroughness: 'quick' } as IAgent;
    expect(pickOrchestrationAgent([a1, a2, a3])?.id).toBe('a2');
  });
});

describe('buildDefaultOrchestrationProfile', () => {
  const ADMIN_DEFAULTS: OrchestrationDefaults = {
    allowedTools: ['web_search', 'file_read', 'coordinate_task'],
    deniedTools: ['delete_file'],
    maxIterations: { quick: 3, medium: 10, very_thorough: 20 },
    defaultThoroughness: 'medium',
    fallbackModels: ['claude-haiku'],
    dagEnabled: true,
  };

  it('marks the result as synthetic with a stable id', () => {
    const profile = buildDefaultOrchestrationProfile(ADMIN_DEFAULTS, 'claude-opus');
    expect(profile.isSynthetic).toBe(true);
    expect(profile.id).toBe('synthetic:default-orchestration');
  });

  it('plumbs the caller-supplied model through to preferredModel (admin settings do NOT pin the model)', () => {
    const profile = buildDefaultOrchestrationProfile(ADMIN_DEFAULTS, 'claude-sonnet');
    expect(profile.preferredModel).toBe('claude-sonnet');
  });

  it('inherits allowedTools / deniedTools / maxIterations from admin defaults', () => {
    const profile = buildDefaultOrchestrationProfile(ADMIN_DEFAULTS, 'claude-opus');
    expect(profile.allowedTools).toEqual(['web_search', 'file_read', 'coordinate_task']);
    expect(profile.deniedTools).toEqual(['delete_file']);
    expect(profile.maxIterations).toEqual({ quick: 3, medium: 10, very_thorough: 20 });
    expect(profile.fallbackModels).toEqual(['claude-haiku']);
  });

  it('strips coordinate_task from allowedTools when dagEnabled is false', () => {
    const profile = buildDefaultOrchestrationProfile({ ...ADMIN_DEFAULTS, dagEnabled: false }, 'claude-opus');
    expect(profile.allowedTools).not.toContain('coordinate_task');
    expect(profile.allowedTools).toContain('web_search');
    expect(profile.dagEnabled).toBe(false);
  });

  it('falls back to the schema seed when adminSettings is null (degraded-mode parity)', () => {
    const profile = buildDefaultOrchestrationProfile(null, 'claude-opus');
    expect(profile.isSynthetic).toBe(true);
    // Same conservative seed an admin sees by default - `getSettingsValue`
    // throwing should land users on the same toolbelt, not an empty one.
    expect(profile.allowedTools).toEqual([
      'web_search',
      'retrieve_knowledge_content',
      'file_read',
      'wikipedia_on_this_day',
      'sunrise_sunset',
      'planet_visibility',
      'code_execute',
      'coordinate_task',
      // Read-only, timezone-aware clock - safe for agent mode, cache-neutral.
      'current_datetime',
      // Storage-backed artifact generation - opted into for agent mode. Write to
      // generated-content storage, not user data.
      'image_generation',
      'edit_image',
      'excel_generation',
      // Inline visualization artifacts - emit an <artifact> block, write nothing.
      'recharts',
      'mermaid_chart',
    ]);
    // Defense-in-depth denylist seeded with every mutating write-tool so
    // broadening `allowedTools` can't silently re-enable a high-blast-radius
    // write. Mirrors `OrchestrationDefaultsSchema.deniedTools`. The
    // storage-backed artifact tools (image/excel) were intentionally moved to
    // `allowedTools` above and are no longer denied.
    expect(profile.deniedTools).toEqual([
      'create_file',
      'edit_file',
      'edit_local_file',
      'delete_file',
      'bash_execute',
      'write_shell_stdin',
      'kill_background_shell',
      'blog_draft',
      'blog_edit',
      'blog_publish',
      'lattice_create_model',
      'lattice_add_entity',
      'lattice_set_value',
      'lattice_create_rule',
    ]);
    expect(profile.maxIterations).toEqual({ quick: 5, medium: 15, very_thorough: 30 });
    expect(profile.defaultThoroughness).toBe('medium');
    expect(profile.dagEnabled).toBe(true);
  });

  it('falls back to the schema seed when adminSettings is undefined', () => {
    const profile = buildDefaultOrchestrationProfile(undefined, 'claude-opus');
    expect(profile.isSynthetic).toBe(true);
    expect(profile.allowedTools).toContain('web_search');
    expect(profile.allowedTools).toContain('code_execute');
  });
});
