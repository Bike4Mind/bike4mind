import { describe, it, expect, vi } from 'vitest';
import type { CitableSource, IChatHistoryItemDocument } from '@bike4mind/common';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

vi.mock('./index', async importOriginal => ({
  ...(await importOriginal<typeof import('./index')>()),
  b4mTools: {},
}));

describe('ToolBuilder citation registry wiring', () => {
  it('shares the live turn registry through the real shared builder and tool generator', async () => {
    const contexts: ToolContext[] = [];
    const probe: ToolDefinition = {
      name: 'probe',
      implementation: context => {
        contexts.push(context);
        return {
          toolFn: async () => '',
          toolSchema: { name: 'probe', description: 'test', parameters: { type: 'object', properties: {} } },
        };
      },
    };
    const sendStatusUpdate = vi.fn();
    const builder = new ToolBuilder({
      user: { id: 'user' },
      authOrigin: 'session',
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate,
    } as unknown as ToolBuilderConfig);
    const source: CitableSource = { id: 'first', type: 'web_url', title: 'First', metadata: { citationIndex: 1 } };
    const quest = { id: 'turn', sessionId: 'session', promptMeta: { citables: [source] } } as IChatHistoryItemDocument;
    builder.buildTools({
      enabledTools: ['probe'],
      externalTools: { probe },
      quest,
      saveQuest: vi.fn(),
      llm: {},
      config: {},
    } as unknown as BuildToolsArgs);

    const context = contexts[0];
    expect(context.registerCitables).toBeTypeOf('function');
    const registered = context.registerCitables!([{ ...source, id: 'next', metadata: undefined }]);
    await context.statusUpdate({ promptMeta: { citables: registered } });
    expect(registered[0].metadata?.citationIndex).toBe(2);
    expect(quest.promptMeta?.citables?.map(c => c.metadata?.citationIndex)).toEqual([1, 2]);
    expect(sendStatusUpdate).toHaveBeenCalledWith(quest, null);
  });
});
