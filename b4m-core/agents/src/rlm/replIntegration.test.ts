import { describe, it, expect, beforeEach } from 'vitest';
import { getOrCreateReplSession, disposeReplSession, _resetReplSessionsForTests } from './ReplSession';
import { makeCodeExecuteTool } from './codeExecuteTool';
import { buildReplToolSystemPrompt, type ReplToolDescriptor } from './prompts';

/**
 * Integration tests for the persistent-REPL substrate as a whole.
 * Verifies the three properties any consumer (TavernReActAgent,
 * /api/opti/rlm-answer, future agents) depends on:
 *
 * 1. Sessions are PER-AGENT and persist across multiple turns/heartbeats
 *    (variables set in turn N are visible in turn N+1)
 * 2. The system-prompt fragment is parameterizable - callers pass
 *    whatever tool descriptor set is wired (empty for tavern v1,
 *    full data-lake set for a product surface)
 * 3. The code_execute tool integrates cleanly with the same
 *    ICompletionOptionTools contract every other tool uses
 */

// Sample descriptor set for "product-surface-style" prompt rendering tests -
// kept inline so this test file has no app-side dependencies.
const SAMPLE_DATA_LAKE_TOOLS: ReplToolDescriptor[] = [
  { name: 'semanticSearch', signature: '({ query, top_k = 10 })', description: 'Vector search.' },
  { name: 'keywordSearch', signature: '({ query, limit = 10 })', description: 'Keyword search.' },
  { name: 'listArticles', signature: '({ tag, limit = 50 })', description: 'Browse by tag.' },
  { name: 'getArticle', signature: '({ file_id })', description: 'Fetch full body.' },
  {
    name: 'subAgentQuery',
    signature: '({ prompt, max_tokens = 1500 })',
    description: 'Sub-LLM call.',
  },
];

describe('REPL substrate integration surface', () => {
  beforeEach(async () => {
    await _resetReplSessionsForTests();
  });

  describe('per-agent session persistence (across heartbeats)', () => {
    it('reusing the same agent session across two heartbeats preserves variables', async () => {
      const agentId = 'agent-bob';
      const sessionKey = `tavern-agent-${agentId}`;

      // Heartbeat 1: agent runs code that stores a fact
      const session1 = getOrCreateReplSession({ sessionId: sessionKey });
      const tool1 = makeCodeExecuteTool({ session: session1 });
      const r1 = await tool1.toolFn({
        code: 'remembered_fact = "Alice prefers tea"; console.log("stored");',
      });
      expect(r1).toContain('stored');

      // Heartbeat 2: same agent, fresh tool instance, but same session lookup
      const session2 = getOrCreateReplSession({ sessionId: sessionKey });
      expect(session2).toBe(session1); // Registry returned the same instance
      const tool2 = makeCodeExecuteTool({ session: session2 });
      const r2 = await tool2.toolFn({
        code: 'console.log(remembered_fact);',
      });
      expect(r2).toContain('Alice prefers tea');
    });

    it('disposing a session drops the persisted state — fresh start on next heartbeat', async () => {
      const sessionKey = 'tavern-agent-charlie';

      const s1 = getOrCreateReplSession({ sessionId: sessionKey });
      const t1 = makeCodeExecuteTool({ session: s1 });
      await t1.toolFn({ code: 'inventory = ["potion", "rope"];' });

      // Agent retires
      disposeReplSession(sessionKey);

      // Fresh heartbeat after retire
      const s2 = getOrCreateReplSession({ sessionId: sessionKey });
      expect(s2).not.toBe(s1);
      const t2 = makeCodeExecuteTool({ session: s2 });
      const r = await t2.toolFn({ code: 'console.log(typeof inventory);' });
      expect(r).toContain('undefined');
    });

    it('different agents have isolated sessions', async () => {
      const sBob = getOrCreateReplSession({ sessionId: 'tavern-agent-bob' });
      const sAlice = getOrCreateReplSession({ sessionId: 'tavern-agent-alice' });

      const tBob = makeCodeExecuteTool({ session: sBob });
      const tAlice = makeCodeExecuteTool({ session: sAlice });

      await tBob.toolFn({ code: 'role = "bartender";' });
      await tAlice.toolFn({ code: 'role = "merchant";' });

      const rBob = await tBob.toolFn({ code: 'console.log(role);' });
      const rAlice = await tAlice.toolFn({ code: 'console.log(role);' });
      expect(rBob).toContain('bartender');
      expect(rAlice).toContain('merchant');
    });
  });

  describe('parameterized system-prompt fragment', () => {
    it('tavern path: empty tool list produces a stdlib-only prompt', () => {
      const prompt = buildReplToolSystemPrompt({ tools: [] });
      expect(prompt).toContain('persistent JavaScript REPL');
      expect(prompt).toContain('(None today');
      // No subAgentQuery sermon when subAgentQuery isn't wired
      expect(prompt).not.toContain('USE THIS — it');
    });

    it('product-surface path: full tool descriptor set names every function', () => {
      const prompt = buildReplToolSystemPrompt({ tools: SAMPLE_DATA_LAKE_TOOLS });
      expect(prompt).toContain('semanticSearch');
      expect(prompt).toContain('keywordSearch');
      expect(prompt).toContain('listArticles');
      expect(prompt).toContain('getArticle');
      expect(prompt).toContain('subAgentQuery');
      // The subAgentQuery sermon shows up because subAgentQuery is in the list
      expect(prompt).toContain("USE THIS — it's why the REPL exists");
    });

    it('partial wiring: only some tools listed, sermon-section gating respects it', () => {
      const prompt = buildReplToolSystemPrompt({
        tools: [
          {
            name: 'semanticSearch',
            signature: '({ query })',
            description: 'Vector search.',
          },
        ],
      });
      expect(prompt).toContain('semanticSearch');
      expect(prompt).not.toContain('subAgentQuery');
      expect(prompt).not.toContain("USE THIS — it's why the REPL exists");
    });
  });

  describe('tool slot-in shape (matches ICompletionOptionTools used by tavern)', () => {
    it('returns the contract ReActAgent expects: { toolFn, toolSchema: { name, description, parameters } }', () => {
      const session = getOrCreateReplSession({ sessionId: 'shape-test' });
      const tool = makeCodeExecuteTool({ session });
      expect(tool.toolSchema.name).toBe('code_execute');
      expect(typeof tool.toolSchema.description).toBe('string');
      expect(tool.toolSchema.parameters).toEqual({
        type: 'object',
        properties: expect.objectContaining({ code: expect.any(Object) }),
        required: ['code'],
      });
      expect(typeof tool.toolFn).toBe('function');
    });

    it('toolFn returns a string observation (matches what ReActAgent accumulates)', async () => {
      const session = getOrCreateReplSession({ sessionId: 'string-test' });
      const tool = makeCodeExecuteTool({ session });
      const result = await tool.toolFn({ code: 'console.log("hi");' });
      expect(typeof result).toBe('string');
      expect(result).toContain('hi');
    });
  });
});
