import { describe, it, expect, vi } from 'vitest';
import { jupyterNotebookTool } from './index';
import type { ToolContext } from '../../base/types';

const NOTEBOOK_JSON = JSON.stringify({
  title: 'T',
  cells: [{ type: 'markdown', content: '# hi' }],
});

/**
 * generate_jupyter_notebook runs its own llm.complete, so it has to forward
 * `context.getAbortSignal()` as `abortSignal` or a user Stop leaves that sub-call generating
 * (and billing) until the provider finishes. See ToolContext.getAbortSignal.
 *
 * Worth having its own test rather than trusting the blog_draft one: the opt-in is a per-call-site
 * one-liner with nothing structural forcing it, so an unthreaded site fails open silently.
 */
describe('jupyterNotebookTool forwards the turn abort signal to its own llm.complete', () => {
  function runTool(getAbortSignal?: () => AbortSignal | undefined) {
    const complete = vi.fn(async (_model, _messages, _options, callback) => {
      await callback([NOTEBOOK_JSON], undefined);
    });
    const context = {
      userId: 'u1',
      user: {},
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      db: {},
      llm: { complete },
      model: 'test-model',
      getAbortSignal,
    } as unknown as ToolContext;

    const run = jupyterNotebookTool
      .implementation(context, undefined)
      .toolFn({ analysisDescription: 'plot something' }, {} as never);

    return { run, optionsOf: () => complete.mock.calls[0]?.[2] };
  }

  it('passes the live signal through as abortSignal', async () => {
    const controller = new AbortController();
    const { run, optionsOf } = runTool(() => controller.signal);
    await run;
    expect(optionsOf()?.abortSignal).toBe(controller.signal);
  });

  it('sends no signal when the host supplies no getter', async () => {
    const { run, optionsOf } = runTool(undefined);
    await run;
    expect(optionsOf()?.abortSignal).toBeUndefined();
  });
});
