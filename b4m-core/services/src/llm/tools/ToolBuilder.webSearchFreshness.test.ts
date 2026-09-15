import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';

/**
 * The freshness nudge is gated on `web_search` actually being enabled for the request. A model
 * told to search without a search tool tends to claim it searched, so the gate is the point of
 * the feature and not an optimization. The wording itself is admin-editable
 * (`WebSearchFreshnessPrompt`), and clearing that setting must drop the section entirely rather
 * than inject an empty heading.
 */
describe('buildToolPrompt web-search freshness section', () => {
  const GUIDANCE = '# WEB SEARCH AND FRESHNESS\n\nsearch when the answer can go stale.';

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

  async function build(overrides: { hasWebSearch: boolean; webSearchGuidance?: string }) {
    return makeBuilder().buildToolPrompt({
      hasContentTransform: false,
      hasChessEngine: false,
      hasCurrentDateTime: false,
      hasKnowledgeBase: false,
      mcpTools: [],
      sessionId: 's1',
      message: 'what is the current price',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      processStartTime: Date.now(),
      ...overrides,
    });
  }

  it('injects the guidance when web_search is enabled', async () => {
    const msg = await build({ hasWebSearch: true, webSearchGuidance: GUIDANCE });
    expect(msg?.content).toContain('WEB SEARCH AND FRESHNESS');
  });

  // Every other section is switched off here, so a correctly gated build contributes no
  // sections at all and buildToolPrompt returns null. Asserting on null rather than on the
  // absence of the heading is what catches a guard that pushes an empty section.
  it('omits it when web_search is not enabled', async () => {
    const msg = await build({ hasWebSearch: false, webSearchGuidance: GUIDANCE });
    expect(msg).toBeNull();
  });

  it('omits it when the admin setting has been cleared', async () => {
    const msg = await build({ hasWebSearch: true, webSearchGuidance: '' });
    expect(msg).toBeNull();
  });
});
