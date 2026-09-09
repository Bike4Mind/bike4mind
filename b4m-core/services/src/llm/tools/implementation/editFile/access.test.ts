import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { editFileTool } from './index';
import type { ToolContext } from '../../base/types';

/**
 * Repairing the `fabFiles` -> `fabfiles` typo took this tool's lookup from "always undefined" to
 * "resolves a row", so the authorization that was never needed while the read was dead is needed
 * now. These pin the three properties that come with a live read: the row must belong to the
 * caller, a curated kbScope refuses the tool outright (ToolContext.kbScope's invariant for any
 * db.fabfiles reader), and an unwired repo is a loud wiring fault rather than a quiet miss.
 */
describe('editFileTool access control', () => {
  const FILE_ID = '68b0f3a2c1d4e5f60718293a';
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

  function makeContext(overrides: Partial<ToolContext>, fabfiles: unknown) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
      userId: 'owner-1',
      user: {},
      logger,
      db: { fabfiles },
      llm: { complete: vi.fn(async (_m, _msgs, _o, cb) => cb(['edited'], undefined)) },
      statusUpdate: vi.fn(),
      model: 'test-model',
      ...overrides,
    } as unknown as ToolContext;
  }

  function run(context: ToolContext) {
    return editFileTool
      .implementation(context, undefined)
      .toolFn({ fileId: FILE_ID, instruction: 'uppercase it' }, {} as never);
  }

  it('scopes the lookup to the caller, so a row owned by someone else is not found', async () => {
    // The repository does the scoping: findByIdAndUserId returns null for a row the caller does
    // not own, exactly as it would for an id with no row at all.
    const findByIdAndUserId = vi.fn(async () => null);
    const context = makeContext({}, { findByIdAndUserId });

    await expect(run(context)).rejects.toThrow(`File with ID ${FILE_ID} not found`);
    expect(findByIdAndUserId).toHaveBeenCalledWith(FILE_ID, 'owner-1');
  });

  it('answers a foreign row exactly as it answers a nonexistent one', async () => {
    // The existence-oracle property, on the ownership axis: a caller must not be able to tell
    // "someone else owns this" from "nothing is here".
    const foreign = makeContext({}, { findByIdAndUserId: vi.fn(async () => null) });
    const missing = makeContext({}, { findByIdAndUserId: vi.fn(async () => null) });

    const foreignError = await run(foreign).catch((e: Error) => e.message);
    const missingError = await run(missing).catch((e: Error) => e.message);

    expect(foreignError).toBe(missingError);
  });

  it('refuses outright in a knowledge-base-scoped session, before touching the repository', async () => {
    const findByIdAndUserId = vi.fn(async () => FILE);
    const context = makeContext({ kbScope: { fileIds: [FILE_ID] } }, { findByIdAndUserId });

    // Even for an id INSIDE the scope: a curated corpus is read-only, so the answer is a refusal
    // rather than a restriction.
    await expect(run(context)).rejects.toThrow(/not available in a knowledge-base-scoped session/);
    expect(findByIdAndUserId).not.toHaveBeenCalled();
  });

  it('reports an unwired repository as a wiring fault, not as a missing file', async () => {
    // `fabfiles` is optional on ToolContext['db']. Answering its absence with the not-found
    // message is the failure mode that hid the dead lookup for this tool's whole lifetime.
    const context = makeContext({}, undefined);

    const message = await run(context).catch((e: Error) => e.message);

    expect(message).toMatch(/not wired on this host/);
    expect(message).not.toMatch(/not found/);
  });
});
