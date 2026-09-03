import { describe, it, expect } from 'vitest';
import {
  buildOptiOrchestrationProfile,
  resolveOptiAgentTools,
  OPTI_CORE_AGENT_TOOLS,
  OPTI_AGENT_LOOP_PROMPT,
} from './agentExecutor.optiProfile';
import { pickEffectiveEnabledTools, pickEffectiveMaxIterations } from './agentExecutor.orchestrationProfile';

// Stands in for `Object.keys(premiumLlmTools)`. Deliberately NOT the real generated map: that map
// is gitignored and empty in a checkout with no overlay hydrated, so asserting against it would
// pass vacuously in CI and drag an overlay's whole tool module into a unit test locally.
const PREMIUM_TOOLS = ['premium_alpha', 'premium_beta'];

const build = (overrides: Partial<Parameters<typeof buildOptiOrchestrationProfile>[0]> = {}) =>
  buildOptiOrchestrationProfile({ premiumToolNames: PREMIUM_TOOLS, ...overrides });

describe('resolveOptiAgentTools', () => {
  it('offers every premium tool the caller passes, plus the core generics', () => {
    expect(resolveOptiAgentTools(PREMIUM_TOOLS)).toEqual(['premium_alpha', 'premium_beta', ...OPTI_CORE_AGENT_TOOLS]);
  });

  // The drift guard this file exists for: the premium half must come from the caller, never from a
  // list written here. A hardcoded tool name would survive every other case in this file, so pin
  // the empty-map result exactly - re-adding one turns this red.
  it('bakes in no premium tool names of its own', () => {
    expect(resolveOptiAgentTools([])).toEqual([...OPTI_CORE_AGENT_TOOLS]);
  });

  it('offers a premium name colliding with a generic once, not twice', () => {
    expect(resolveOptiAgentTools(['premium_alpha', 'web_search'])).toEqual([
      'premium_alpha',
      'web_search',
      'retrieve_knowledge_content',
      'current_datetime',
    ]);
  });
});

describe('buildOptiOrchestrationProfile', () => {
  it('offers the derived optimizer tools plus safe generics, and nothing else', () => {
    const profile = build();
    expect(profile.allowedTools).toEqual(resolveOptiAgentTools(PREMIUM_TOOLS));
    // No general-purpose escape hatches that would pull the loop off-task.
    expect(profile.allowedTools).not.toContain('image_generation');
    expect(profile.allowedTools).not.toContain('coordinate_task');
  });

  it('offers retrieve_knowledge_content so attached files are readable, without open-ended lake search', () => {
    const profile = build();
    // The agent path injects attached files as metadata only and points the agent at
    // `retrieve_knowledge_content`; dropping it makes every attachment on this surface
    // unreadable even though the file ingested fine.
    expect(profile.allowedTools).toContain('retrieve_knowledge_content');
    // Reading an explicitly attached file keeps the loop on task; open-ended lake search
    // invites it off task, and that search stays available on the chat path.
    expect(profile.allowedTools).not.toContain('search_knowledge_base');
  });

  // A host with no overlay hydrated generates an empty premium map. Offering only the generics is
  // the honest outcome; the previous hardcoded list named five tools that resolved to nothing.
  it('degrades to the core generics when no premium tools are registered', () => {
    expect(build({ premiumToolNames: [] }).allowedTools).toEqual([...OPTI_CORE_AGENT_TOOLS]);
  });

  it('denies image generation and multi-agent delegation', () => {
    const profile = build();
    expect(profile.deniedTools).toEqual(
      expect.arrayContaining(['image_generation', 'edit_image', 'delegate_to_agent', 'coordinate_task'])
    );
  });

  it('is a synthetic profile with a stable id and the loop prompt as its persona', () => {
    const profile = build();
    expect(profile.isSynthetic).toBe(true);
    expect(profile.id).toBe('synthetic:opti-orchestration');
    expect(profile.systemPrompt).toBe(OPTI_AGENT_LOOP_PROMPT);
  });

  it('accepts a system-prompt override (e.g. an admin-tuned prompt)', () => {
    expect(build({ systemPrompt: 'CUSTOM PROMPT' }).systemPrompt).toBe('CUSTOM PROMPT');
  });

  it('raises the iteration ceiling so a multi-step ladder does not truncate mid-walk', () => {
    const profile = build();
    expect(profile.defaultThoroughness).toBe('very_thorough');
    // A decompose + per-step formulate/solve/read walk needs headroom.
    expect(pickEffectiveMaxIterations(undefined, profile)).toBeGreaterThanOrEqual(30);
  });
});

describe('opti profile x pickEffectiveEnabledTools', () => {
  it('resolves the optimizer tools when the payload pins none', () => {
    const profile = build();
    expect(pickEffectiveEnabledTools(undefined, profile)).toEqual(resolveOptiAgentTools(PREMIUM_TOOLS));
  });

  // The exclusivity is what fixes the production failure this guards: a classifier-routed
  // send carries the chat surface's tool selection in the payload, and replacing the
  // walk's toolset with it left the agent unable to decompose the scenario it was asked
  // to break down. Pinned as a flag assertion too, so deleting the flag from the profile
  // turns a test red rather than only changing behaviour.
  //
  // It is also why deriving the list matters: with the payload ignored, this profile is the ONLY
  // thing that decides, so a name missing from it has no caller-side escape hatch.
  it('declares its toolset exclusive, so a payload selection cannot narrow the walk', () => {
    const profile = build();
    expect(profile.toolsetIsExclusive).toBe(true);
    expect(pickEffectiveEnabledTools(['premium_alpha'], profile)).toEqual(resolveOptiAgentTools(PREMIUM_TOOLS));
  });

  // NOT a subtraction test: the optimizer toolset never contained image_generation, and the
  // exclusive toolset ignores the payload, so the denylist has nothing visible to remove
  // here (a previous version of this case passed with OPTI_DENIED_TOOLS emptied). The
  // denylist's real job on this profile is downstream - agentExecutor subtracts it from
  // the run's final toolbelt after the mission/lattice appends - so what this file can
  // honestly pin is the config itself, which the 'denies image generation and multi-agent
  // delegation' case above already does.
  it('yields the full optimizer toolset even when the payload names a denied tool', () => {
    const profile = build();
    expect(pickEffectiveEnabledTools(['image_generation'], profile)).toEqual(resolveOptiAgentTools(PREMIUM_TOOLS));
  });
});
