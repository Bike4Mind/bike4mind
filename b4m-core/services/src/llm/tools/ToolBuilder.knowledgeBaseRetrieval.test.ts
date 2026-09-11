import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

/**
 * The retrieval nudge is gated on `search_knowledge_base` actually surviving into the offered tool
 * set. Telling a model to search a corpus it has no tool for makes it claim it searched, so the
 * gate is the feature and not an optimization. The wording is admin-editable
 * (`KnowledgeBaseRetrievalPrompt`) and clearing that setting is the section's only off switch, so
 * a cleared value must drop it entirely rather than inject an empty heading.
 *
 * Mirrors ToolBuilder.webSearchFreshness.test.ts - the two sections share a gating shape, and a
 * change to one that skips the other is the drift these two files are here to catch.
 */
describe('buildToolPrompt knowledge-base retrieval section', () => {
  const GUIDANCE = '# KNOWLEDGE BASE\n\nsearch when the answer is in the user documents.';

  function makeBuilder(): ToolBuilder {
    return new ToolBuilder({
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
    } as unknown as ToolBuilderConfig);
  }

  async function build(overrides: { hasKnowledgeBase: boolean; knowledgeBaseGuidance?: string }) {
    return makeBuilder().buildToolPrompt({
      hasContentTransform: false,
      hasChessEngine: false,
      hasCurrentDateTime: false,
      hasWebSearch: false,
      mcpTools: [],
      sessionId: 's1',
      message: 'what did we decide about pricing',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      processStartTime: Date.now(),
      ...overrides,
    });
  }

  it('injects the guidance when search_knowledge_base is offered', async () => {
    const msg = await build({ hasKnowledgeBase: true, knowledgeBaseGuidance: GUIDANCE });
    expect(msg?.content).toContain('KNOWLEDGE BASE');
  });

  // Every other section is switched off here, so a correctly gated build contributes no sections
  // at all and buildToolPrompt returns null. Asserting on null rather than on the absence of the
  // heading is what catches a guard that pushes an empty section.
  it('omits it when the knowledge tool is not offered', async () => {
    const msg = await build({ hasKnowledgeBase: false, knowledgeBaseGuidance: GUIDANCE });
    expect(msg).toBeNull();
  });

  it('omits it when the admin setting has been cleared', async () => {
    const msg = await build({ hasKnowledgeBase: true, knowledgeBaseGuidance: '' });
    expect(msg).toBeNull();
  });
});
