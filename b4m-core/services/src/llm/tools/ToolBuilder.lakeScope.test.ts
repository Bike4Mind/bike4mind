import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

// Same stub, and for the same reason, as ToolBuilder.inlinedAttachmentIds.test.ts: only the probe
// below should be built, but the ToolBuilder -> buildSharedTools -> generateTools chain stays real.
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>();
  return { ...actual, b4mTools: {} };
});

/**
 * Proves the session's lake scope reaches ToolContext as a PAIR through the real plumbing.
 *
 * `sessionLakeScopeExplicit` is the half that fails silently: resolveSessionLakeAccess reads an
 * empty `sessionRetrievalTags` without it as "expressed no lake opinion" and hands the tools the
 * caller's entire owner-wide lake access - the exact opposite of the deliberate no-lake scope it
 * is meant to carry. Nothing about that is a type error, so only observing the real built context
 * catches a link dropped anywhere in ToolBuilder / buildSharedTools / generateTools.
 */
describe('ToolBuilder threads the session lake scope into ToolContext', () => {
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

  function buildWith(overrides: Partial<ToolBuilderConfig>): ToolContext | undefined {
    const { tool, getContext } = probeTool();
    const deps = {
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
      ...overrides,
    } as unknown as ToolBuilderConfig;
    new ToolBuilder(deps).buildTools({
      enabledTools: ['probe'],
      externalTools: { probe: tool },
      quest: {} as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs);
    return getContext();
  }

  it('passes both halves of a deliberate no-lake scope through', () => {
    const context = buildWith({ sessionRetrievalTags: [], sessionLakeScopeExplicit: true });
    expect(context?.sessionRetrievalTags).toEqual([]);
    expect(context?.sessionLakeScopeExplicit).toBe(true);
  });

  it('passes a named lake scope through', () => {
    const context = buildWith({ sessionRetrievalTags: ['datalake:alpha'], sessionLakeScopeExplicit: true });
    expect(context?.sessionRetrievalTags).toEqual(['datalake:alpha']);
    expect(context?.sessionLakeScopeExplicit).toBe(true);
  });

  it('leaves both undefined on a surface that sets neither', () => {
    const context = buildWith({});
    expect(context?.sessionRetrievalTags).toBeUndefined();
    expect(context?.sessionLakeScopeExplicit).toBeUndefined();
  });
});
