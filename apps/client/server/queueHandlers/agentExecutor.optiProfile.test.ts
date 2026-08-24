import { describe, it, expect } from 'vitest';
import { buildOptiOrchestrationProfile, OPTI_AGENT_TOOLS, OPTI_AGENT_LOOP_PROMPT } from './agentExecutor.optiProfile';
import { pickEffectiveEnabledTools, pickEffectiveMaxIterations } from './agentExecutor.orchestrationProfile';

describe('buildOptiOrchestrationProfile', () => {
  it('offers the optimizer tools plus safe generics, and nothing else', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(profile.allowedTools).toEqual(OPTI_AGENT_TOOLS);
    expect(profile.allowedTools).toContain('optihashi_decompose');
    expect(profile.allowedTools).toContain('optihashi_formulate');
    expect(profile.allowedTools).toContain('optihashi_edit_problem');
    expect(profile.allowedTools).toContain('optihashi_schedule');
    expect(profile.allowedTools).toContain('optihashi_solve');
    // No general-purpose escape hatches that would pull the loop off-task.
    expect(profile.allowedTools).not.toContain('image_generation');
    expect(profile.allowedTools).not.toContain('coordinate_task');
  });

  it('offers retrieve_knowledge_content so attached files are readable, without open-ended lake search', () => {
    const profile = buildOptiOrchestrationProfile();
    // The agent path injects attached files as metadata only and points the agent at
    // `retrieve_knowledge_content`; dropping it makes every attachment on this surface
    // unreadable even though the file ingested fine.
    expect(profile.allowedTools).toContain('retrieve_knowledge_content');
    // Reading an explicitly attached file keeps the loop on task; open-ended lake search
    // invites it off task, and that search stays available on the chat path.
    expect(profile.allowedTools).not.toContain('search_knowledge_base');
  });

  it('denies image generation and multi-agent delegation', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(profile.deniedTools).toEqual(
      expect.arrayContaining(['image_generation', 'edit_image', 'delegate_to_agent', 'coordinate_task'])
    );
  });

  it('is a synthetic profile with a stable id and the loop prompt as its persona', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(profile.isSynthetic).toBe(true);
    expect(profile.id).toBe('synthetic:opti-orchestration');
    expect(profile.systemPrompt).toBe(OPTI_AGENT_LOOP_PROMPT);
  });

  it('accepts a system-prompt override (e.g. an admin-tuned prompt)', () => {
    const profile = buildOptiOrchestrationProfile('CUSTOM PROMPT');
    expect(profile.systemPrompt).toBe('CUSTOM PROMPT');
  });

  it('raises the iteration ceiling so a multi-step ladder does not truncate mid-walk', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(profile.defaultThoroughness).toBe('very_thorough');
    // A decompose + per-step formulate/solve/read walk needs headroom.
    expect(pickEffectiveMaxIterations(undefined, profile)).toBeGreaterThanOrEqual(30);
  });
});

describe('opti profile x pickEffectiveEnabledTools', () => {
  it('resolves the optimizer tools when the payload pins none', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(pickEffectiveEnabledTools(undefined, profile)).toEqual(OPTI_AGENT_TOOLS);
  });

  // The exclusivity is what fixes the production failure this guards: a classifier-routed
  // send carries the chat surface's tool selection in the payload, and replacing the
  // walk's toolset with it left the agent unable to decompose the scenario it was asked
  // to break down. Pinned as a flag assertion too, so deleting the flag from the profile
  // turns a test red rather than only changing behaviour.
  it('declares its toolset exclusive, so a payload selection cannot narrow the walk', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(profile.toolsetIsExclusive).toBe(true);
    expect(pickEffectiveEnabledTools(['optihashi_formulate'], profile)).toEqual(OPTI_AGENT_TOOLS);
  });

  // NOT a subtraction test: OPTI_AGENT_TOOLS never contained image_generation, and the
  // exclusive toolset ignores the payload, so the denylist has nothing visible to remove
  // here (a previous version of this case passed with OPTI_DENIED_TOOLS emptied). The
  // denylist's only name-level enforcement is pickEffectiveEnabledTools itself; the
  // delegation pair is enforced at the dependency gate (delegationOffer withholds
  // agentStore/dagDispatcher - see sessionToolPolicy). What this file can honestly pin
  // is the config, which the 'denies image generation and multi-agent delegation' case
  // above already does.
  it('yields the full optimizer toolset even when the payload names a denied tool', () => {
    const profile = buildOptiOrchestrationProfile();
    expect(pickEffectiveEnabledTools(['image_generation'], profile)).toEqual(OPTI_AGENT_TOOLS);
  });
});
