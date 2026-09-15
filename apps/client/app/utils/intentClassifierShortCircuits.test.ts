import { describe, it, expect, vi } from 'vitest';

vi.mock('./commands', () => ({
  isImageModel: (model: string) => /^(image|dall|flux|gpt-image|sd|stable-diffusion)/i.test(model),
}));

import {
  evaluateShortCircuits,
  MAX_CLASSIFIABLE_LENGTH,
  MIN_CLASSIFIABLE_LENGTH,
} from './intentClassifierShortCircuits';
import type { ShortCircuitContext } from './intentClassifierShortCircuits';

/** Base context where no predicate fires; every test starts here then flips one field. */
const baseCtx: ShortCircuitContext = {
  message: 'compare these two approaches in detail',
  agentToggleEnabled: false,
  hasAgentMention: false,
  hasAgentLiteral: false,
  model: 'claude-4-6-sonnet',
  isRealSlashCommand: false,
  disableAutoRouteForThisSession: false,
  intentClassifierAdminEnabled: true,
};

describe('evaluateShortCircuits', () => {
  it('returns shortCircuit=false when no predicate fires', () => {
    expect(evaluateShortCircuits(baseCtx)).toEqual({ shortCircuit: false });
  });

  // Priority order: when multiple predicates fire, the highest-priority one wins.
  describe('priority order', () => {
    it('admin_disabled beats every other predicate', () => {
      const ctx: ShortCircuitContext = {
        ...baseCtx,
        intentClassifierAdminEnabled: false,
        disableAutoRouteForThisSession: true,
        isRealSlashCommand: true,
        hasAgentLiteral: true,
        hasAgentMention: true,
        agentToggleEnabled: true,
        model: 'flux-pro-ultra',
        message: 'hi',
      };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'admin_disabled' });
    });

    it('session_opt_out beats slash_command / mention / toggle / image / length', () => {
      const ctx: ShortCircuitContext = {
        ...baseCtx,
        disableAutoRouteForThisSession: true,
        isRealSlashCommand: true,
        hasAgentLiteral: true,
        hasAgentMention: true,
        agentToggleEnabled: true,
        model: 'flux-pro-ultra',
        message: 'hi',
      };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'session_opt_out' });
    });

    it('slash_command beats mention / toggle / image / length', () => {
      const ctx: ShortCircuitContext = {
        ...baseCtx,
        isRealSlashCommand: true,
        hasAgentLiteral: true,
        agentToggleEnabled: true,
        model: 'flux-pro-ultra',
        message: 'hi',
      };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'slash_command' });
    });

    it('agent_literal beats agent_mention (literal is the more specific signal)', () => {
      const ctx: ShortCircuitContext = { ...baseCtx, hasAgentLiteral: true, hasAgentMention: true };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'agent_literal' });
    });

    it('agent_mention beats agent_toggle', () => {
      const ctx: ShortCircuitContext = { ...baseCtx, hasAgentMention: true, agentToggleEnabled: true };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'agent_mention' });
    });

    it('agent_toggle beats image_model and length checks', () => {
      const ctx: ShortCircuitContext = { ...baseCtx, agentToggleEnabled: true, model: 'flux-pro-ultra', message: 'hi' };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'agent_toggle' });
    });

    it('image_model beats length checks', () => {
      const ctx: ShortCircuitContext = { ...baseCtx, model: 'flux-pro-ultra', message: 'hi' };
      expect(evaluateShortCircuits(ctx)).toEqual({ shortCircuit: true, reason: 'image_model' });
    });
  });

  // Each predicate in isolation
  describe('individual predicates', () => {
    it('flags admin_disabled when the admin kill switch is off', () => {
      expect(evaluateShortCircuits({ ...baseCtx, intentClassifierAdminEnabled: false })).toEqual({
        shortCircuit: true,
        reason: 'admin_disabled',
      });
    });

    it('flags session_opt_out when the user dismissed the badge this session', () => {
      expect(evaluateShortCircuits({ ...baseCtx, disableAutoRouteForThisSession: true })).toEqual({
        shortCircuit: true,
        reason: 'session_opt_out',
      });
    });

    it('flags slash_command for real slash dispatches', () => {
      expect(evaluateShortCircuits({ ...baseCtx, isRealSlashCommand: true })).toEqual({
        shortCircuit: true,
        reason: 'slash_command',
      });
    });

    it('flags agent_literal for the `@agent` trigger', () => {
      expect(evaluateShortCircuits({ ...baseCtx, hasAgentLiteral: true })).toEqual({
        shortCircuit: true,
        reason: 'agent_literal',
      });
    });

    it('flags agent_mention for `@<name>` mentions', () => {
      expect(evaluateShortCircuits({ ...baseCtx, hasAgentMention: true })).toEqual({
        shortCircuit: true,
        reason: 'agent_mention',
      });
    });

    it('flags agent_toggle when the composer toggle / always-on default is active', () => {
      expect(evaluateShortCircuits({ ...baseCtx, agentToggleEnabled: true })).toEqual({
        shortCircuit: true,
        reason: 'agent_toggle',
      });
    });

    it('flags image_model when an image-gen model is selected', () => {
      expect(evaluateShortCircuits({ ...baseCtx, model: 'flux-pro-ultra' })).toEqual({
        shortCircuit: true,
        reason: 'image_model',
      });
    });

    it(`flags message_too_short below ${MIN_CLASSIFIABLE_LENGTH} chars`, () => {
      expect(evaluateShortCircuits({ ...baseCtx, message: 'hi' })).toEqual({
        shortCircuit: true,
        reason: 'message_too_short',
      });
    });

    it(`flags message_too_long above ${MAX_CLASSIFIABLE_LENGTH} chars`, () => {
      const longMsg = 'x'.repeat(MAX_CLASSIFIABLE_LENGTH + 1);
      expect(evaluateShortCircuits({ ...baseCtx, message: longMsg })).toEqual({
        shortCircuit: true,
        reason: 'message_too_long',
      });
    });
  });

  // Boundary conditions on length; off-by-one regressions are easy here.
  describe('length boundaries', () => {
    it(`accepts exactly ${MIN_CLASSIFIABLE_LENGTH} chars`, () => {
      const msg = 'x'.repeat(MIN_CLASSIFIABLE_LENGTH);
      expect(evaluateShortCircuits({ ...baseCtx, message: msg })).toEqual({ shortCircuit: false });
    });

    it(`accepts exactly ${MAX_CLASSIFIABLE_LENGTH} chars`, () => {
      const msg = 'x'.repeat(MAX_CLASSIFIABLE_LENGTH);
      expect(evaluateShortCircuits({ ...baseCtx, message: msg })).toEqual({ shortCircuit: false });
    });
  });
});
