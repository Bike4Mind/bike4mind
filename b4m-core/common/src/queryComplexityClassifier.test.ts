import { describe, expect, it } from 'vitest';
import { routeQuery, type AgentRoutingContext } from './queryComplexityClassifier';

// Routing contract - base behavior plus three rules:
//   - `userOverride` (Agent-mode toggle) wins over every other signal
//   - `hasOrchestrationAgent` preserves the @specific-agent dispatch path
//   - The pre-existing `@agent` literal + complexity heuristic still apply
//
// These are deliberately exhaustive - routeQuery is the single source of
// truth for the chat-vs-agent_executor decision (consolidated into
// @bike4mind/common), and silent regressions here either drop the
// agent_executor flow entirely or mis-route normal chats.

function ctx(overrides: Partial<AgentRoutingContext> = {}): AgentRoutingContext {
  return {
    message: 'hello',
    complexity: 'simple',
    agentExecutorEnabled: false,
    ...overrides,
  };
}

describe('routeQuery', () => {
  describe('userOverride', () => {
    it('force_agent short-circuits to agent_executor regardless of other signals', () => {
      expect(
        routeQuery(
          ctx({
            userOverride: 'force_agent',
            agentExecutorEnabled: false,
            complexity: 'simple',
          })
        )
      ).toBe('agent_executor');
    });

    it('force_normal forces quest_processor even when the feature flag is on and an agent is mentioned', () => {
      expect(
        routeQuery(
          ctx({
            userOverride: 'force_normal',
            agentExecutorEnabled: true,
            hasOrchestrationAgent: true,
            message: '@agent please help',
            complexity: 'complex',
          })
        )
      ).toBe('quest_processor');
    });
  });

  describe('hasOrchestrationAgent', () => {
    it('routes to agent_executor when an orchestration agent is mentioned and the feature is enabled', () => {
      expect(
        routeQuery(
          ctx({
            hasOrchestrationAgent: true,
            agentExecutorEnabled: true,
          })
        )
      ).toBe('agent_executor');
    });

    it('does not route to agent_executor when an orchestration agent is mentioned but the feature is disabled', () => {
      expect(
        routeQuery(
          ctx({
            hasOrchestrationAgent: true,
            agentExecutorEnabled: false,
          })
        )
      ).toBe('quest_processor');
    });
  });

  describe('feature flag gating', () => {
    it('returns quest_processor when the feature flag is off (no override, no orchestration agent)', () => {
      expect(routeQuery(ctx({ agentExecutorEnabled: false, complexity: 'complex' }))).toBe('quest_processor');
    });
  });

  describe('@agent literal', () => {
    it('routes to agent_executor on explicit `@agent` mention when the feature is enabled', () => {
      expect(
        routeQuery(
          ctx({
            message: '@agent help me research X',
            agentExecutorEnabled: true,
          })
        )
      ).toBe('agent_executor');
    });

    it('does not match generic @<name> mentions', () => {
      expect(
        routeQuery(
          ctx({
            message: '@hello what is up',
            agentExecutorEnabled: true,
            complexity: 'simple',
          })
        )
      ).toBe('quest_processor');
    });
  });

  describe('complexity heuristic', () => {
    it('routes complex queries to agent_executor when the feature is enabled and auto-routing is opted in', () => {
      expect(routeQuery(ctx({ complexity: 'complex', agentExecutorEnabled: true, autoRouteEnabled: true }))).toBe(
        'agent_executor'
      );
    });

    it('keeps complex queries on quest_processor when auto-routing is NOT opted in (toggle/default off)', () => {
      // Regression: recharts tool -> 'complex', feature flag on, but the
      // composer toggle is OFF and default !== 'auto' -> must stay on chat.
      expect(routeQuery(ctx({ complexity: 'complex', agentExecutorEnabled: true }))).toBe('quest_processor');
      expect(routeQuery(ctx({ complexity: 'complex', agentExecutorEnabled: true, autoRouteEnabled: false }))).toBe(
        'quest_processor'
      );
    });

    it('keeps contextual/simple queries on quest_processor even when auto-routing is opted in', () => {
      expect(routeQuery(ctx({ complexity: 'contextual', agentExecutorEnabled: true, autoRouteEnabled: true }))).toBe(
        'quest_processor'
      );
      expect(routeQuery(ctx({ complexity: 'simple', agentExecutorEnabled: true, autoRouteEnabled: true }))).toBe(
        'quest_processor'
      );
    });

    it('still honors explicit signals when auto-routing is off (force_agent / @agent / orchestration agent)', () => {
      // autoRouteEnabled only gates the complexity fall-through - explicit
      // user intent must dispatch regardless.
      expect(routeQuery(ctx({ userOverride: 'force_agent', complexity: 'complex', autoRouteEnabled: false }))).toBe(
        'agent_executor'
      );
      expect(routeQuery(ctx({ message: '@agent help', agentExecutorEnabled: true, autoRouteEnabled: false }))).toBe(
        'agent_executor'
      );
      expect(
        routeQuery(ctx({ hasOrchestrationAgent: true, agentExecutorEnabled: true, autoRouteEnabled: false }))
      ).toBe('agent_executor');
    });
  });
});
