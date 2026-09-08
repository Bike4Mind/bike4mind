import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { editFileTool } from './index';
import type { ToolContext } from '../../base/types';

/**
 * edit_file runs its own llm.complete, so it has to forward `context.getAbortSignal()` as
 * `abortSignal` or a user Stop leaves that sub-call generating (and billing). See
 * ToolContext.getAbortSignal.
 *
 * The catch block matters as much as the forwarding here. Making the sub-call cancellable means
 * this tool now sees AbortError for the first time, and the pre-existing handler both logged it
 * at error level (so every Stop reads as an edit_file fault) and rewrapped it in a fresh Error
 * (destroying the identity isUserInitiatedAbort needs upstream). Both branches are pinned below.
 */
describe('editFileTool cancellation handling', () => {
  // moderationStatus must be 'clean': isImageServeable fail-closes on EVERY mime type, not just
  // images, so a fixture without it is refused before the LLM call this test is about.
  const FILE = {
    fileName: 'a.txt',
    mimeType: 'text/plain',
    fileUrl: 'https://files.example/a.txt',
    moderationStatus: 'clean',
  };

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, statusText: 'OK', text: async () => 'original content' }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeContext(
    getAbortSignal: (() => AbortSignal | undefined) | undefined,
    complete: ReturnType<typeof vi.fn>
  ) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const context = {
      userId: 'u1',
      user: {},
      logger,
      db: { fabFiles: { findById: vi.fn(async () => FILE) } },
      llm: { complete },
      statusUpdate: vi.fn(),
      model: 'test-model',
      getAbortSignal,
    } as unknown as ToolContext;
    return { context, logger };
  }

  function run(context: ToolContext) {
    return editFileTool
      .implementation(context, undefined)
      .toolFn({ fileId: 'f1', instruction: 'uppercase it' }, {} as never);
  }

  it('passes the live signal through as abortSignal', async () => {
    const controller = new AbortController();
    const complete = vi.fn(async (_m, _msgs, _o, cb) => cb(['edited'], undefined));
    const { context } = makeContext(() => controller.signal, complete);

    await run(context);

    expect(complete.mock.calls[0][2].abortSignal).toBe(controller.signal);
  });

  it('sends no signal when the host supplies no getter', async () => {
    const complete = vi.fn(async (_m, _msgs, _o, cb) => cb(['edited'], undefined));
    const { context } = makeContext(undefined, complete);

    await run(context);

    expect(complete.mock.calls[0][2].abortSignal).toBeUndefined();
  });

  it('rethrows a user Stop unwrapped and does not log it as a fault', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const complete = vi.fn(async () => {
      throw abortError;
    });
    const { context, logger } = makeContext(() => controller.signal, complete);

    // The ORIGINAL error object, not a `Failed to edit file: ...` rewrap - upstream
    // isUserInitiatedAbort checks match on the AbortError identity.
    await expect(run(context)).rejects.toBe(abortError);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('still reports a genuine failure as an error, wrapped as before', async () => {
    const complete = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const { context, logger } = makeContext(() => new AbortController().signal, complete);

    await expect(run(context)).rejects.toThrow(/Failed to edit file: provider exploded/);
    expect(logger.error).toHaveBeenCalled();
  });
});
