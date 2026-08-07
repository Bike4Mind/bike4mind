import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

// b4mTools pulls in every real tool implementation (image generation, excel export, ...) and
// building its full context graph is not what this test is about - stub it to empty so only the
// probe tool below gets built. generateTools/generateMcpTools* stay real: this test exists to
// prove the REAL ToolBuilder -> buildSharedTools -> generateTools chain, not a mock of it.
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>();
  return { ...actual, b4mTools: {} };
});

/**
 * Proves inlinedAttachmentIds (#1163) actually reaches ToolContext through the real
 * ToolBuilder.buildTools -> buildSharedTools -> generateTools chain. The knowledge-tool wording
 * tests (knowledgeBaseRetrieve/Search) exercise the CONSUMER side against a hand-built
 * ToolContext, which cannot catch a break anywhere upstream of that - an unthreaded optional
 * field fails open silently (it is simply undefined), so this has to observe the real value
 * produced by the real plumbing, not a value handed to a mock.
 */
describe('ToolBuilder threads inlinedAttachmentIds into ToolContext', () => {
  function probeTool(): { tool: ToolDefinition; getContext: () => ToolContext | undefined } {
    let seen: ToolContext | undefined;
    const tool: ToolDefinition = {
      implementation: context => {
        seen = context as ToolContext;
        return {
          toolFn: async () => '',
          toolSchema: { name: 'probe', description: 'test probe', parameters: { type: 'object', properties: {} } },
        };
      },
    };
    return { tool, getContext: () => seen };
  }

  function makeBuilder(inlinedAttachmentIds?: string[]): ToolBuilder {
    const deps = {
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
      inlinedAttachmentIds,
    } as unknown as ToolBuilderConfig;
    return new ToolBuilder(deps);
  }

  function callBuildTools(builder: ToolBuilder, tool: ToolDefinition): void {
    builder.buildTools({
      enabledTools: ['probe'],
      externalTools: { probe: tool },
      quest: {} as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs);
  }

  it('passes inlinedAttachmentIds through to the tool context', () => {
    const { tool, getContext } = probeTool();
    callBuildTools(makeBuilder(['f1', 'f2']), tool);
    expect(getContext()?.inlinedAttachmentIds).toEqual(['f1', 'f2']);
  });

  it('leaves inlinedAttachmentIds undefined when the caller never sets it (non-chat surfaces)', () => {
    const { tool, getContext } = probeTool();
    callBuildTools(makeBuilder(undefined), tool);
    expect(getContext()?.inlinedAttachmentIds).toBeUndefined();
  });
});
