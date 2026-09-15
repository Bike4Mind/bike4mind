import { describe, it, expect, vi } from 'vitest';
import { ToolBuilder, type ToolBuilderConfig, type BuildToolsArgs } from './ToolBuilder';
import type { ToolDefinition, ToolContext } from './base/types';

// Same stub rationale as ToolBuilder.inlinedAttachmentIds.test.ts: b4mTools drags in every real
// tool implementation, and only the probe below matters here. generateTools stays real - the point
// is to exercise the actual ToolBuilder -> buildSharedTools -> generateTools chain.
vi.mock('./index', async importOriginal => {
  const actual = await importOriginal<typeof import('./index')>();
  return { ...actual, b4mTools: {} };
});

/**
 * Proves the turn's cancellation signal reaches ToolContext, so a tool that runs its own
 * llm.complete can be stopped. Before this was threaded, the signal stopped at
 * delegate_to_agent / coordinate_task and every generic tool got a ToolContext with no
 * cancellation field at all - a Stop settled the chat turn while the tool's nested generation
 * kept billing.
 *
 * The laziness case is the load-bearing one. Tools are built during tool setup, before the
 * turn's AbortController exists, so the contract has to be a getter over a holder the host
 * fills in later. A captured AbortSignal would type-check, pass a naive "is it defined" test
 * at invocation time, and still be a permanent undefined in production.
 */
describe('ToolBuilder threads getAbortSignal into ToolContext', () => {
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

  function makeBuilder(): ToolBuilder {
    const deps = {
      user: { id: 'u1' },
      db: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() },
      storage: {},
      imageGenerateStorage: {},
      toolCreditsMap: new Map(),
      subagentTelemetryData: [],
      sendStatusUpdate: vi.fn(),
    } as unknown as ToolBuilderConfig;
    return new ToolBuilder(deps);
  }

  function callBuildTools(tool: ToolDefinition, getAbortSignal?: () => AbortSignal | undefined): void {
    makeBuilder().buildTools({
      enabledTools: ['probe'],
      externalTools: { probe: tool },
      getAbortSignal,
      quest: {} as never,
      saveQuest: vi.fn() as never,
      llm: {} as never,
      config: {},
    } as unknown as BuildToolsArgs);
  }

  it('resolves the signal at tool-invocation time, not at build time', () => {
    // Mirrors the real host: the holder is empty while tools are built and only filled in once
    // the turn's AbortController is created, several hundred lines later.
    const holder: { signal?: AbortSignal } = {};
    const { tool, getContext } = probeTool();

    callBuildTools(tool, () => holder.signal);
    expect(getContext()?.getAbortSignal).toBeTypeOf('function');
    expect(getContext()?.getAbortSignal?.()).toBeUndefined();

    const controller = new AbortController();
    holder.signal = controller.signal;

    expect(getContext()?.getAbortSignal?.()).toBe(controller.signal);
  });

  it('surfaces the aborted state through the same getter once the turn is stopped', () => {
    const controller = new AbortController();
    const { tool, getContext } = probeTool();

    callBuildTools(tool, () => controller.signal);
    expect(getContext()?.getAbortSignal?.()?.aborted).toBe(false);

    controller.abort();
    expect(getContext()?.getAbortSignal?.()?.aborted).toBe(true);
  });

  it('leaves getAbortSignal undefined on hosts that supply no controller', () => {
    const { tool, getContext } = probeTool();
    callBuildTools(tool, undefined);
    expect(getContext()?.getAbortSignal).toBeUndefined();
  });
});
