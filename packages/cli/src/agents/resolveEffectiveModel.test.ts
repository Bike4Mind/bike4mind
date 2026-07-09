import { describe, it, expect } from 'vitest';
import { resolveEffectiveModel } from './resolveEffectiveModel.js';

describe('resolveEffectiveModel', () => {
  const base = {
    agentModel: 'placeholder-default',
    agentModelResolved: false,
  };

  it('honors an explicit per-spawn request above everything else', () => {
    expect(
      resolveEffectiveModel({
        ...base,
        requestedModel: 'requested',
        agentModelResolved: true,
        parentModel: 'parent',
        sessionDefaultModel: 'session',
      })
    ).toBe('requested');
  });

  it("uses the agent's declared model when resolved and no request is given", () => {
    expect(
      resolveEffectiveModel({
        agentModel: 'agent-declared',
        agentModelResolved: true,
        parentModel: 'parent',
        sessionDefaultModel: 'session',
      })
    ).toBe('agent-declared');
  });

  it('inherits the parent model when the agent model is unresolved', () => {
    expect(
      resolveEffectiveModel({
        ...base,
        parentModel: 'parent',
        sessionDefaultModel: 'session',
      })
    ).toBe('parent');
  });

  it('falls back to the session model when there is no parent to inherit from', () => {
    expect(
      resolveEffectiveModel({
        ...base,
        sessionDefaultModel: 'session',
      })
    ).toBe('session');
  });

  it('falls back to the agent placeholder only as a last resort', () => {
    expect(resolveEffectiveModel(base)).toBe('placeholder-default');
  });

  it('does not let an unresolved child silently diverge from the parent model', () => {
    // No request, no declared model: the child must follow the parent, never a
    // different session/hardcoded default.
    const result = resolveEffectiveModel({
      ...base,
      parentModel: 'parent-granted',
      sessionDefaultModel: 'stronger-session-default',
    });
    expect(result).toBe('parent-granted');
  });
});
