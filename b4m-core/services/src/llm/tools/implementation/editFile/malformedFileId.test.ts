import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { editFileTool } from './index';
import type { ToolContext } from '../../base/types';

/**
 * `fileId` is a bare `z.string()` composed by the model, so it routinely holds something that is
 * not an id at all. Unguarded it reaches Mongoose's `_id` cast, and the CastError surfaces to the
 * model as `Failed to edit file: Cast to ObjectId failed for value "..." at path "_id"` - our
 * internals, with no hint that it should go and find the real id. The guard answers it as the
 * miss it is, identically to a well-formed id with no row behind it.
 */
describe('editFileTool malformed fileId handling', () => {
  const MALFORMED_FILE_ID = 'Handbook.pdf';
  const WELL_FORMED_FILE_ID = '68b0f3a2c1d4e5f60718293a';

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, statusText: 'OK', text: async () => 'original content' }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function makeContext(findById: ReturnType<typeof vi.fn>) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
      userId: 'u1',
      user: {},
      logger,
      db: { fabfiles: { findById } },
      llm: { complete: vi.fn(async (_m, _msgs, _o, cb) => cb(['edited'], undefined)) },
      statusUpdate: vi.fn(),
      model: 'test-model',
    } as unknown as ToolContext;
  }

  function run(context: ToolContext, fileId: string) {
    return editFileTool.implementation(context, undefined).toolFn({ fileId, instruction: 'uppercase it' }, {} as never);
  }

  it.each([
    ['a bare filename', 'Handbook.pdf'],
    ['a filename token', 'w7154539641'],
    ['an id with the dot mangled to a space', '2506 07866'],
    ['a 23-hex near-miss', '68b0f3a2c1d4e5f6071829'],
  ])('rejects %s without querying for it', async (_label, fileId) => {
    const findById = vi.fn();
    const context = makeContext(findById);

    await expect(run(context, fileId)).rejects.toThrow(`File with ID ${fileId} not found`);
    // The point of the guard: the value never reaches the `_id` cast that would throw a CastError.
    expect(findById).not.toHaveBeenCalled();
  });

  it('tells the model the same thing a well-formed id with no row behind it does', async () => {
    const malformed = makeContext(vi.fn());
    const missing = makeContext(vi.fn(async () => null));

    const malformedError = await run(malformed, MALFORMED_FILE_ID).catch((e: Error) => e.message);
    const missingError = await run(missing, WELL_FORMED_FILE_ID).catch((e: Error) => e.message);

    // Identical modulo the echoed id: a malformed id must not be distinguishable from a missing
    // one, and specifically must not hand the model the cast internals it used to get.
    expect(malformedError).toBe(missingError.replace(WELL_FORMED_FILE_ID, MALFORMED_FILE_ID));
    expect(malformedError).not.toMatch(/Cast to ObjectId/);
  });

  // Doubles as the regression pin for a lookup that read `db.fabFiles` through an `as any`
  // cast - a key no host wiring this tool populates, so `?.` returned undefined and EVERY id,
  // real ones included, fell through to the not-found above. Mock the key the hosts actually
  // wire (`fabfiles`) or this test pins the bug instead of the behaviour.
  it('reaches the repository for a well-formed id and goes on to edit', async () => {
    const findById = vi.fn(async () => ({
      fileName: 'a.txt',
      mimeType: 'text/plain',
      fileUrl: 'https://files.example/a.txt',
      moderationStatus: 'clean',
    }));
    const context = makeContext(findById);

    const result = await run(context, WELL_FORMED_FILE_ID);

    expect(findById).toHaveBeenCalledWith(WELL_FORMED_FILE_ID);
    expect(JSON.stringify(result)).not.toMatch(/not found/);
  });
});
