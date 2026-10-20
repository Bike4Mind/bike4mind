import { describe, it, expect, vi } from 'vitest';
import type { CitableSource } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

// Same stub rationale as ToolBuilder.abortSignal.test.ts: b4mTools drags in every real tool
// implementation. buildSharedTools and generateTools stay real so the whole chain is exercised.
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>();
  return { ...actual, b4mTools: {} };
});

const citable = (id: string, citationIndex?: number): CitableSource =>
  ({
    id,
    type: 'web_url',
    title: id,
    url: `https://example.com/${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    ...(citationIndex === undefined ? {} : { metadata: { citationIndex } }),
  }) as CitableSource;

const numbersOf = (citables: readonly CitableSource[] | undefined) => citables?.map(c => c.metadata?.citationIndex);

type Quest = { id: string; sessionId: string; promptMeta?: { citables?: CitableSource[] } };

describe('ToolBuilder threads numberCitables into ToolContext', () => {
  function probeTool(): { tool: ToolDefinition; getContext: () => ToolContext | undefined } {
    let seen: ToolContext | undefined;
    const tool: ToolDefinition = {
      name: 'probe',
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

  function build(citationStyle: 'named' | 'indexed' | undefined, quest: Quest): ToolContext | undefined {
    const deps = {
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
      ...(citationStyle === undefined ? {} : { citationStyle }),
    } as unknown as ToolBuilderConfig;
    const { tool, getContext } = probeTool();
    new ToolBuilder(deps).buildTools({
      enabledTools: ['probe'],
      externalTools: { probe: tool },
      quest: quest as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs);
    return getContext();
  }

  const makeQuest = (): Quest => ({
    id: 'q1',
    sessionId: 's1',
    promptMeta: { citables: [citable('f1', 1), citable('f2', 2)] },
  });

  it("numbers parallel tool calls back to back and merges them onto the live quest when style is 'indexed'", () => {
    const quest = makeQuest();
    const [w1, w2, kb1] = [citable('w1'), citable('w2'), citable('kb1')];
    const context = build('indexed', quest);

    expect(context?.numberCitables).toBeTypeOf('function');
    expect(numbersOf(context?.numberCitables?.([w1, w2]))).toEqual([3, 4]);
    expect(numbersOf(context?.numberCitables?.([w2, kb1]))).toEqual([4, 5]);

    expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['f1', 'f2', 'w1', 'w2', 'kb1']);
    expect(numbersOf(quest.promptMeta?.citables)).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves numberCitables undefined when style is 'named'", () => {
    expect(build('named', makeQuest())?.numberCitables).toBeUndefined();
  });

  it('leaves numberCitables undefined when no citation style is set', () => {
    expect(build(undefined, makeQuest())?.numberCitables).toBeUndefined();
  });
});
