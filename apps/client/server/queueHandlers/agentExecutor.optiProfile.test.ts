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
    // No general-purpose escape hatches that would pull the loop off-task.
    expect(profile.allowedTools).not.toContain('image_generation');
    expect(profile.allowedTools).not.toContain('coordinate_task');
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

  it('strips denied tools even when a payload override tries to re-add image generation', () => {
    const profile = buildOptiOrchestrationProfile();
    const effective = pickEffectiveEnabledTools(['optihashi_formulate', 'image_generation'], profile);
    expect(effective).toContain('optihashi_formulate');
    expect(effective).not.toContain('image_generation');
  });
});
