# Chunk Char Length + Per-File Text Length Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `charLength` on every chunk, `chunkedCharCount` on every file, and `totalChunkedChars` on every lake, with a standalone backfill for existing data (issue #1665, spec: `docs/superpowers/specs/2026-08-12-chunk-char-length-design.md`).

**Architecture:** Three derived fields, each summed from the level below: chunk `charLength` (Unicode code points of `text`) is stamped at chunk time; file `chunkedCharCount` is the sum of its chunks, stamped in the same `chunkFabfile` update that already writes `chunkCount`; lake `totalChunkedChars` rides the existing `computeDataLakeStats` aggregate + `setStats` recompute path. A standalone script backfills legacy documents, computing chunk lengths server-side via a `$strLenCP` pipeline update so chunk text never leaves the database.

**Tech Stack:** TypeScript monorepo (pnpm + turbo), Mongoose/MongoDB, vitest (`mongodb-memory-server` via `setupMongoTest()` in `@bike4mind/database`), `tsx` + `sst shell` for the script.

## Global Constraints

- **Unit is Unicode CODE POINTS**, never `text.length` (UTF-16 units). The live write path uses the shared `countCodePoints` helper; the backfill uses MongoDB `$strLenCP`. They must compute the same number.
- **Exact field names:** `charLength` (chunk), `chunkedCharCount` (file, nullable), `totalChunkedChars` (lake). All optional in types (legacy docs), always written by the write paths.
- **Never increment rollups in place** - lake stats are always re-derived by `computeDataLakeStats` and persisted by `setStats`.
- **ASCII only** in code and comments (repo rule; typographic chars only as `\u` escapes).
- **No `any`** without a documented reason; **no `index: true`** on schema fields; no new indexes at all (spec: nothing here is queried on a hot path).
- Database tests must use the existing `setupMongoTest()` (`packages/database/src/__test__/utils`), never `MongoMemoryServer.create()` directly.
- Conventional Commits; branch is `feat/datalake-chunk-char-length` (already created).
- Fresh worktree setup (once, before Task 1): `pnpm install`, then `pnpm turbo:core:build`. After editing `b4m-core/common`, rebuild it (`pnpm --filter @bike4mind/common build`) before running dependent packages' tests.
- Run focused tests with `pnpm --filter <pkg> exec vitest run <path>` (never `pnpm --filter @bike4mind/client test -- run <path>`).

---

### Task 1: `countCodePoints` helper in `@bike4mind/common`

**Files:**
- Create: `b4m-core/common/src/utils/countCodePoints.ts`
- Create: `b4m-core/common/src/utils/countCodePoints.test.ts`
- Modify: `b4m-core/common/src/index.ts` (add one export line near the other `./utils/*` exports at lines 62-65)

**Interfaces:**
- Consumes: nothing.
- Produces: `countCodePoints(text: string): number`, exported from `@bike4mind/common`. Tasks 2 and 5 import it.

- [ ] **Step 0: Workspace setup (once per worktree)**

Run: `pnpm install && pnpm turbo:core:build`
Expected: install and core build succeed. (A missing premium overlay warning is benign.)

- [ ] **Step 1: Write the failing test**

`b4m-core/common/src/utils/countCodePoints.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countCodePoints } from './countCodePoints';

describe('countCodePoints', () => {
  it('counts ASCII text as its length', () => {
    expect(countCodePoints('hello world')).toBe(11);
  });

  it('returns 0 for the empty string', () => {
    expect(countCodePoints('')).toBe(0);
  });

  it('counts an astral character as ONE code point, not two UTF-16 units', () => {
    const emoji = '\u{1F600}';
    expect(emoji.length).toBe(2); // the trap this helper exists to avoid
    expect(countCodePoints(emoji)).toBe(1);
    expect(countCodePoints(`a${emoji}b`)).toBe(3);
  });

  it('counts BMP non-ASCII characters as one each', () => {
    // 'privet' in cyrillic, written as escapes per the repo's ASCII-only source rule
    expect(countCodePoints('\u043f\u0440\u0438\u0432\u0435\u0442')).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bike4mind/common exec vitest run src/utils/countCodePoints.test.ts`
Expected: FAIL - cannot resolve `./countCodePoints`.

- [ ] **Step 3: Write the implementation**

`b4m-core/common/src/utils/countCodePoints.ts`:

```ts
/**
 * Length of `text` in Unicode CODE POINTS - the unit `IFabFileChunk.charLength` is stored in.
 * Matches MongoDB's `$strLenCP`, which is what lets the char-length backfill
 * (packages/scripts/datalake/backfill-chunk-char-length.ts) compute the same number server-side
 * without reading chunk text out of the database. Deliberately NOT `text.length` (UTF-16 code
 * units): the two differ on astral characters (surrogate pairs), and the write path and the
 * backfill must agree exactly.
 */
export const countCodePoints = (text: string): number => {
  let count = 0;
  // for..of iterates by code point, so a surrogate pair advances once.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ch of text) count++;
  return count;
};
```

(If the lint disable proves unnecessary in this package's ESLint config, drop it.)

Add to `b4m-core/common/src/index.ts`, next to the existing `./utils/*` export lines:

```ts
export * from './utils/countCodePoints';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @bike4mind/common exec vitest run src/utils/countCodePoints.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @bike4mind/common typecheck && pnpm --filter @bike4mind/common build`

```bash
git add b4m-core/common/src/utils/countCodePoints.ts b4m-core/common/src/utils/countCodePoints.test.ts b4m-core/common/src/index.ts
git commit -m "feat(common): add countCodePoints helper for chunk char length"
```

---

### Task 2: chunk `charLength` + file `chunkedCharCount` on the write paths

**Files:**
- Modify: `b4m-core/common/src/types/entities/FabFileTypes.ts` (`IFabFileChunk` ~line 55, `IFabFile` ~line 129, `FAB_FILE_CONTENT_REWRITE_PATCH` ~line 258)
- Modify: `packages/database/src/models/content/FabFileModel.ts` (`FabFileChunkSchema` ~line 250, `FabFileSchema` ~line 1222)
- Modify: `b4m-core/services/src/fabFileService/chunk.ts` (~lines 91-124)
- Modify: `packages/scripts/help/ingest-help-datalake.ts` (~lines 178-240)
- Modify: `b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts`
- Test: `b4m-core/services/src/fabFileService/chunk.test.ts`

**Interfaces:**
- Consumes: `countCodePoints` from `@bike4mind/common` (Task 1).
- Produces: `IFabFileChunk.charLength?: number`; `IFabFile.chunkedCharCount?: number | null`; `FAB_FILE_CONTENT_REWRITE_PATCH = { extractedCharCount: null, chunkedCharCount: null }`; schema fields of the same names. Tasks 3-5 rely on these exact names.

- [ ] **Step 1: Write the failing service test**

Append inside the existing `describe('chunkFabfile', ...)` in `b4m-core/services/src/fabFileService/chunk.test.ts` (it already mocks `SmartChunker` and builds `mockAdapter` in `beforeEach`):

```ts
it('stamps charLength (code points) on every inserted chunk and their sum on the file', async () => {
  (SmartChunker as unknown as Mock).mockImplementation(function MockSmartChunker(this: unknown) {
    return {
      chunkFile: vi.fn().mockResolvedValue([
        { text: 'chunk one', tokenCount: 2 }, // 9 code points
        { text: 'four\u{1F600}', tokenCount: 2 }, // 5 code points, 6 UTF-16 units
      ]),
      freeEncoder: vi.fn(),
    };
  });

  await chunkFabfile(
    mockUser,
    { fabFileId: 'file-1', embeddingModel: 'text-embedding-ada-002' },
    mockAdapter as never
  );

  const inserted = mockAdapter.db.fabFileChunks.bulkInsert.mock.calls[0][0] as Array<{ charLength: number }>;
  expect(inserted.map(c => c.charLength)).toEqual([9, 5]);

  const updatedFile = mockAdapter.db.fabFiles.update.mock.calls[0][0] as { chunkedCharCount: number };
  expect(updatedFile.chunkedCharCount).toBe(14);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bike4mind/services exec vitest run src/fabFileService/chunk.test.ts`
Expected: the new test FAILS (`charLength` undefined); every pre-existing test still passes.

- [ ] **Step 3: Add the type fields and widen the rewrite patch**

In `b4m-core/common/src/types/entities/FabFileTypes.ts`:

`IFabFileChunk` gains, after `tokenCount`:

```ts
  /**
   * Length of `text` in Unicode CODE POINTS (countCodePoints on the write path, $strLenCP in the
   * backfill - the two must agree, which is why this is NOT UTF-16 `text.length`). Written at
   * chunk time; absent on chunks that predate the field until
   * packages/scripts/datalake/backfill-chunk-char-length.ts runs. Unit basis for the lake
   * health predicates (#1666), which are stated in characters because the serve cap is.
   */
  charLength?: number;
```

`IFabFile` gains, after the `vectorizedChunkCount` field (~line 131):

```ts
  /**
   * Sum of this file's chunks' `charLength` (Unicode code points), stamped by chunkFabfile in
   * the same update as `chunkCount`. The chunk-derived counterpart of `extractedCharCount`,
   * which a DIFFERENT extractor writes lazily on the composer dry-run path - the two
   * legitimately drift and must not be conflated. Nullable for the same reason as
   * extractedCharCount: a content rewrite nulls it via FAB_FILE_CONTENT_REWRITE_PATCH (Mongoose
   * strips undefined from $set) and the re-chunk that follows re-stamps it.
   */
  chunkedCharCount?: number | null;
```

Widen the patch constant (keep its existing doc comment, adding one sentence noting it now also clears the chunk-derived sum):

```ts
export const FAB_FILE_CONTENT_REWRITE_PATCH = { extractedCharCount: null, chunkedCharCount: null } as const;
```

- [ ] **Step 4: Add the schema fields**

In `packages/database/src/models/content/FabFileModel.ts`:

`FabFileChunkSchema` (after `tokenCount`):

```ts
    // Unicode code points of `text` (countCodePoints / $strLenCP); see IFabFileChunk.charLength.
    charLength: { type: Number, required: false },
```

`FabFileSchema` (after `vectorizedChunkCount`):

```ts
    // Sum of the file's chunks' charLength; nulled on content rewrite. See IFabFile.chunkedCharCount.
    chunkedCharCount: { type: Number, required: false },
```

- [ ] **Step 5: Stamp both fields in `chunkFabfile`**

In `b4m-core/services/src/fabFileService/chunk.ts`:

Add to the imports from `@bike4mind/common`: `countCodePoints`.

After `const chunks = await chunker.chunkFile(fabFile);` (line ~78) compute the lengths once:

```ts
  const chunkCharLengths = chunks.map(chunk => countCodePoints(chunk.text));
```

Next to `fabFile.chunkCount = chunks.length;` (line ~93) add:

```ts
  fabFile.chunkedCharCount = chunkCharLengths.reduce((sum, len) => sum + len, 0);
```

In the `fabFileChunks` map (lines ~113-122), attach the per-chunk value:

```ts
  const fabFileChunks = await Promise.all(
    chunks.map(async (chunk, i) => {
      return {
        ...chunk,
        charLength: chunkCharLengths[i],
        fabFileId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    })
  );
```

- [ ] **Step 6: Run the service test to verify it passes**

Run: `pnpm --filter @bike4mind/common build && pnpm --filter @bike4mind/services exec vitest run src/fabFileService/chunk.test.ts`
Expected: PASS (all tests, including the new one).

- [ ] **Step 7: Extend the invalidation guard test**

In `b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts`, add (source-pattern style, consistent with the file):

```ts
  it('the shared patch also clears the chunk-derived length (chunkedCharCount)', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');
    expect(source).toContain(
      'FAB_FILE_CONTENT_REWRITE_PATCH = { extractedCharCount: null, chunkedCharCount: null }'
    );
  });
```

Run: `pnpm --filter @bike4mind/infra exec vitest run src/__tests__/fabFileExtractedCountInvalidation.test.ts`
Expected: PASS.

- [ ] **Step 8: Stamp the secondary door (help-ingest script)**

In `packages/scripts/help/ingest-help-datalake.ts`:

- Add `countCodePoints` to the existing `@bike4mind/common` import.
- In the section loop where `chunkPayloads.push({...})` is built (~line 184), add `charLength: countCodePoints(text),` next to `tokenCount`.
- In the `fabFileRepository.create({...})` call (~line 213), next to `chunkCount: chunkPayloads.length,` add:

```ts
      chunkedCharCount: chunkPayloads.reduce((sum, c) => sum + (c.charLength ?? 0), 0),
```

- [ ] **Step 9: Typecheck the touched packages**

Run: `pnpm --filter @bike4mind/common typecheck && pnpm --filter @bike4mind/database typecheck && pnpm --filter @bike4mind/services typecheck && pnpm --filter @bike4mind/scripts typecheck`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add b4m-core/common/src/types/entities/FabFileTypes.ts packages/database/src/models/content/FabFileModel.ts b4m-core/services/src/fabFileService/chunk.ts b4m-core/services/src/fabFileService/chunk.test.ts packages/scripts/help/ingest-help-datalake.ts b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts
git commit -m "feat(data-lake): stamp chunk charLength and file chunkedCharCount at chunk time"
```

---

### Task 3: lake rollup `totalChunkedChars`

**Files:**
- Modify: `b4m-core/common/src/types/entities/DataLakeTypes.ts` (`IDataLake` ~line 113, `setStats` contract line 228)
- Modify: `b4m-core/common/src/types/entities/FabFileTypes.ts` (`IFabFileRepository.computeDataLakeStats` contract, line ~683)
- Modify: `packages/database/src/models/content/FabFileModel.ts` (`computeDataLakeStats`, lines 884-898)
- Modify: `packages/database/src/models/ai/DataLakeModel.ts` (schema lines 74-75, `setStats` lines 404-411)
- Modify: `b4m-core/services/src/dataLakeService/createDataLake.ts` (~line 123)
- Modify: `b4m-core/services/src/dataLakeService/recomputeLakeStats.ts` (return type, line ~62)
- Test: `packages/database/src/models/content/FabFileModel.dataLakeLifecycle.test.ts` (existing `describe('computeDataLakeStats')` at line 99)

**Interfaces:**
- Consumes: `IFabFile.chunkedCharCount` (Task 2).
- Produces: `computeDataLakeStats` returns `{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }`; `setStats(id, stats)` accepts the same triple; `IDataLake.totalChunkedChars?: number`. Task 5's phase 3 relies on `recomputeLakeStats` carrying the new field.

- [ ] **Step 1: Write the failing database test**

In `packages/database/src/models/content/FabFileModel.dataLakeLifecycle.test.ts`, inside `describe('computeDataLakeStats')`, add:

```ts
    it('sums member files chunkedCharCount, treating missing as 0', async () => {
      const rows = await seedLakeRows();
      await FabFile.updateOne({ _id: rows.metaTagged._id }, { $set: { chunkedCharCount: 1200 } });
      // prefixOwned deliberately left without the field (legacy doc).
      // Stranger-owned rows must not contribute even when stamped:
      await FabFile.updateOne({ _id: rows.unrelated._id }, { $set: { chunkedCharCount: 999 } });

      const stats = await fabFileRepository.computeDataLakeStats(scope);

      expect(stats.totalChunkedChars).toBe(1200);
    });
```

Also update the existing exact-shape assertion at ~line 115 (`counted only the meta-tagged file...`) to include the new key:

```ts
      expect(await fabFileRepository.computeDataLakeStats(metaOnlyScope)).toEqual({
        fileCount: 1,
        totalSizeBytes: 100,
        totalChunkedChars: 0,
      });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @bike4mind/database exec vitest run src/models/content/FabFileModel.dataLakeLifecycle.test.ts`
Expected: the new test FAILS (`totalChunkedChars` undefined). The updated `toEqual` also fails until Step 3.

- [ ] **Step 3: Widen the aggregate and the contracts**

`packages/database/src/models/content/FabFileModel.ts`, `computeDataLakeStats`:

```ts
  async computeDataLakeStats(
    scope: DataLakeMembershipScope
  ): Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }> {
    const [agg] = await this.fabFileModel.aggregate<{
      fileCount: number;
      totalSizeBytes: number;
      totalChunkedChars: number;
    }>([
      {
        $match: {
          ...buildDataLakeMembershipFilter(scope),
          deletedAt: null,
          archivedAt: null,
          status: { $ne: 'pending' },
        },
      },
      {
        $group: {
          _id: null,
          fileCount: { $sum: 1 },
          totalSizeBytes: { $sum: { $ifNull: ['$fileSize', 0] } },
          totalChunkedChars: { $sum: { $ifNull: ['$chunkedCharCount', 0] } },
        },
      },
      { $project: { _id: 0, fileCount: 1, totalSizeBytes: 1, totalChunkedChars: 1 } },
    ]);
    return agg ?? { fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 };
  }
```

`b4m-core/common/src/types/entities/FabFileTypes.ts` line ~683 - widen the contract to the same return type.

`b4m-core/common/src/types/entities/DataLakeTypes.ts`:
- `IDataLake` gains, after `totalSizeBytes` (~line 113):

```ts
  /**
   * Cached sum of member files' chunkedCharCount (Unicode code points of chunked text) -
   * the retrievable-content denominator for lake health (#1666). Recomputed with
   * fileCount/totalSizeBytes by recomputeLakeStats; never incremented in place.
   */
  totalChunkedChars?: number;
```

- Line 228, widen the repository contract:

```ts
  setStats(
    id: string,
    stats: { fileCount: number; totalSizeBytes: number; totalChunkedChars: number }
  ): Promise<IDataLakeDocument | null>;
```

`packages/database/src/models/ai/DataLakeModel.ts`:
- Schema, after `totalSizeBytes` (line 75): `totalChunkedChars: { type: Number, default: 0 },`
- `setStats` (line 404): widen the parameter type identically and add `totalChunkedChars: stats.totalChunkedChars` to the `$set`.

`b4m-core/services/src/dataLakeService/createDataLake.ts` (~line 123): next to `fileCount: 0, totalSizeBytes: 0,` add `totalChunkedChars: 0,`.

`b4m-core/services/src/dataLakeService/recomputeLakeStats.ts`: widen the declared return type to `Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }>` (the body already passes the whole stats object through).

- [ ] **Step 4: Run tests and fix type fallout**

Run: `pnpm --filter @bike4mind/common build && pnpm --filter @bike4mind/database exec vitest run src/models/content/FabFileModel.dataLakeLifecycle.test.ts`
Expected: PASS.

Run: `pnpm turbo:typecheck`
Expected: any test double or caller typed against the old `{ fileCount, totalSizeBytes }` shapes surfaces here (e.g. mocks of `computeDataLakeStats`/`setStats` in service tests). Fix each by adding `totalChunkedChars: 0` (or the obvious sum) to the literal - do not loosen types to make errors go away.

- [ ] **Step 5: Run the affected package test suites**

Run: `pnpm --filter @bike4mind/database test && pnpm --filter @bike4mind/services test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A b4m-core/common b4m-core/services packages/database
git commit -m "feat(data-lake): cache totalChunkedChars on lakes via the stats recompute path"
```

---

### Task 4: backfill repository primitives

**Files:**
- Modify: `packages/database/src/models/content/FabFileModel.ts` (`FabFileChunkRepository` ~line 50-248; `FabFileRepository` - the class that owns `computeDataLakeStats`)
- Modify: `b4m-core/common/src/types/entities/FabFileTypes.ts` (`IFabFileChunkRepository` line 285, `IFabFileRepository` ~line 683)
- Test: Create `packages/database/src/models/content/FabFileModel.charLengthBackfill.test.ts`

**Interfaces:**
- Consumes: `charLength` / `chunkedCharCount` schema fields (Task 2).
- Produces (Task 5 calls all four):
  - `fabFileChunkRepository.findChunkIdsMissingCharLength(options?: { limit?: number; afterChunkId?: string }): Promise<string[]>`
  - `fabFileChunkRepository.backfillCharLengthByIds(chunkIds: string[]): Promise<number>`
  - `fabFileChunkRepository.sumChunkCharLengthByFabFileId(fabFileId: string): Promise<number>`
  - `fabFileRepository.findFileIdsMissingChunkedCharCount(options?: { limit?: number; afterFileId?: string }): Promise<string[]>`
  - `fabFileRepository.setChunkedCharCount(id: string, chunkedCharCount: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `packages/database/src/models/content/FabFileModel.charLengthBackfill.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';
import { FabFile, FabFileChunk, fabFileChunkRepository, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const makeChunk = (fabFileId: string, text: string, charLength?: number) =>
  FabFileChunk.create({
    fabFileId,
    text,
    tokenCount: 1,
    ...(charLength !== undefined ? { charLength } : {}),
  });

const makeFile = (fileName: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({ userId: 'u1', fileName, type: KnowledgeType.TEXT, ...extra });

describe('charLength backfill primitives', () => {
  setupMongoTest();

  it('pages chunk ids still missing charLength, ascending by _id', async () => {
    const a = await makeChunk('f1', 'aaa');
    await makeChunk('f1', 'stamped', 7);
    const c = await makeChunk('f2', 'cc');

    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength();
    expect(ids).toEqual([String(a._id), String(c._id)]);

    const page = await fabFileChunkRepository.findChunkIdsMissingCharLength({
      limit: 1,
      afterChunkId: String(a._id),
    });
    expect(page).toEqual([String(c._id)]);
  });

  it('stamps charLength server-side in CODE POINTS and reruns find nothing (idempotent)', async () => {
    const emoji = '\u{1F600}';
    const chunk = await makeChunk('f1', `four${emoji}`); // 5 code points, 6 UTF-16 units

    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength();
    const modified = await fabFileChunkRepository.backfillCharLengthByIds(ids);
    expect(modified).toBe(1);

    const stored = await FabFileChunk.findById(chunk._id).lean();
    expect(stored?.charLength).toBe(5);

    expect(await fabFileChunkRepository.findChunkIdsMissingCharLength()).toEqual([]);
    expect(await fabFileChunkRepository.backfillCharLengthByIds([])).toBe(0);
  });

  it('sums a file chunks charLength treating an unstamped chunk as 0', async () => {
    await makeChunk('f1', 'aaa', 3);
    await makeChunk('f1', 'bbbb', 4);
    await makeChunk('f1', 'not-yet-stamped');
    await makeChunk('f2', 'other-file', 100);

    expect(await fabFileChunkRepository.sumChunkCharLengthByFabFileId('f1')).toBe(7);
    expect(await fabFileChunkRepository.sumChunkCharLengthByFabFileId('missing')).toBe(0);
  });

  it('pages files that have chunks but no chunkedCharCount, and setChunkedCharCount removes them', async () => {
    const missing = await makeFile('missing.txt', { chunkCount: 2 });
    await makeFile('stamped.txt', { chunkCount: 2, chunkedCharCount: 7 });
    await makeFile('chunkless.txt', { chunkCount: 0 });
    // Nulled by a content rewrite - must be picked up again:
    const nulled = await makeFile('nulled.txt', { chunkCount: 1, chunkedCharCount: null });

    const ids = await fabFileRepository.findFileIdsMissingChunkedCharCount();
    expect(ids).toEqual([String(missing._id), String(nulled._id)]);

    await fabFileRepository.setChunkedCharCount(String(missing._id), 9);
    expect(await fabFileRepository.findFileIdsMissingChunkedCharCount()).toEqual([String(nulled._id)]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @bike4mind/database exec vitest run src/models/content/FabFileModel.charLengthBackfill.test.ts`
Expected: FAIL - the repository methods do not exist.

- [ ] **Step 3: Implement the repository methods**

In `packages/database/src/models/content/FabFileModel.ts`, on `FabFileChunkRepository` (next to `findChunksMissingEmbeddingModel`, whose keyset-cursor pattern these follow):

```ts
  /**
   * One page of chunk ids still missing `charLength`, ascending by `_id` - the char-length
   * backfill's keyset cursor (packages/scripts/datalake/backfill-chunk-char-length.ts).
   * `charLength: null` deliberately matches missing AND explicit null.
   */
  async findChunkIdsMissingCharLength(
    options: { limit?: number; afterChunkId?: string } = {}
  ): Promise<string[]> {
    const { limit = 5_000, afterChunkId } = options;
    const docs = await this.fabFileChunkModel
      .find({ charLength: null, ...(afterChunkId ? { _id: { $gt: afterChunkId } } : {}) })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => String(d._id));
  }

  /**
   * Stamp `charLength` on the given chunks server-side: a pipeline update computing $strLenCP
   * over the stored text, so chunk text never leaves the database. Counts Unicode code points -
   * the same number countCodePoints produces on the live write path (see that helper's comment
   * for why the two must agree).
   */
  async backfillCharLengthByIds(chunkIds: string[]): Promise<number> {
    if (chunkIds.length === 0) return 0;
    const result = await this.fabFileChunkModel.updateMany({ _id: { $in: chunkIds } }, [
      { $set: { charLength: { $strLenCP: '$text' } } },
    ]);
    return result.modifiedCount;
  }

  /** Sum of a file's chunks' charLength, unstamped chunks counted as 0 - backfill phase 2 input. */
  async sumChunkCharLengthByFabFileId(fabFileId: string): Promise<number> {
    const [agg] = await this.fabFileChunkModel.aggregate<{ total: number }>([
      { $match: { fabFileId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$charLength', 0] } } } },
    ]);
    return agg?.total ?? 0;
  }
```

On the FabFile repository class (near `computeDataLakeStats`):

```ts
  /**
   * One page of file ids that have chunks but no `chunkedCharCount` (missing or nulled by a
   * content rewrite), ascending by `_id` - the char-length backfill's phase-2 cursor.
   */
  async findFileIdsMissingChunkedCharCount(
    options: { limit?: number; afterFileId?: string } = {}
  ): Promise<string[]> {
    const { limit = 1_000, afterFileId } = options;
    const docs = await this.fabFileModel
      .find({
        chunkedCharCount: null,
        chunkCount: { $gt: 0 },
        ...(afterFileId ? { _id: { $gt: afterFileId } } : {}),
      })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => String(d._id));
  }

  async setChunkedCharCount(id: string, chunkedCharCount: number): Promise<void> {
    await this.fabFileModel.updateOne({ _id: id }, { $set: { chunkedCharCount } });
  }
```

Add matching signatures with one-line doc comments to `IFabFileChunkRepository` (line 285, next to `findChunksMissingEmbeddingModel`) and `IFabFileRepository` (~line 683) in `b4m-core/common/src/types/entities/FabFileTypes.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @bike4mind/common build && pnpm --filter @bike4mind/database exec vitest run src/models/content/FabFileModel.charLengthBackfill.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @bike4mind/common typecheck && pnpm --filter @bike4mind/database typecheck`

```bash
git add b4m-core/common/src/types/entities/FabFileTypes.ts packages/database/src/models/content/FabFileModel.ts packages/database/src/models/content/FabFileModel.charLengthBackfill.test.ts
git commit -m "feat(data-lake): repository primitives for the chunk charLength backfill"
```

---

### Task 5: the backfill script

**Files:**
- Create: `packages/scripts/datalake/backfill-chunk-char-length.ts`

**Interfaces:**
- Consumes: all five Task 4 primitives; `dataLakeService.recomputeLakeStats` (Task 3 return shape); `DataLakeModel`, `dataLakeRepository`, `fabFileRepository`, `fabFileChunkRepository`, `connectDB` from `@bike4mind/database`.
- Produces: a runnable one-off script; nothing imports it.

No unit test: the script is glue over primitives tested in Task 4, matching the
`backfill-chunk-embedding-model.ts` precedent (whose only tested logic, `backfillPlan.ts`, was a
pure planning function this script does not need).

- [ ] **Step 1: Write the script**

Create `packages/scripts/datalake/backfill-chunk-char-length.ts`:

```ts
#!/usr/bin/env tsx
/**
 * One-time backfill for issue #1665: stamp `charLength` onto FabFileChunks, `chunkedCharCount`
 * onto their files, and `totalChunkedChars` onto lakes - the data the lake health predicates
 * (#1666) are computed from. The live write path (chunkFabfile) stamps all three going forward;
 * this trues up documents that predate the fields.
 *
 * Standalone script rather than a migration for the same reason as
 * backfill-chunk-embedding-model.ts: a bounded, one-time sweep over existing data that must not
 * gate a deploy.
 *
 * Three phases, strictly ordered (2 sums what 1 wrote; 3 sums what 2 wrote):
 *   1. Chunks: pipeline update computing $strLenCP('$text') server-side - chunk text never
 *      leaves the database. Same number countCodePoints produces on the write path.
 *   2. Files: chunkedCharCount = sum of the file's chunk charLengths.
 *   3. Lakes: recomputeLakeStats over every non-deleted lake (now carries totalChunkedChars).
 *
 * Idempotent/resumable: phases 1 and 2 only match documents still missing the field, so a rerun
 * after a partial failure picks up where it left off. Phase 3 recomputes unconditionally (cheap:
 * one aggregate + one write per lake) and skips activation - a metadata backfill must not carry
 * the one-way draft -> active publication side effect.
 *
 * Dry-run by default; pass --execute to write.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-chunk-char-length.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/backfill-chunk-char-length.ts --execute
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  connectDB,
  DataLakeModel,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

interface Options {
  execute: boolean;
  batchSize: number;
}

async function backfillChunks(opts: Options): Promise<number> {
  let processed = 0;
  let afterChunkId: string | undefined;
  for (;;) {
    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength({
      limit: opts.batchSize,
      afterChunkId,
    });
    if (ids.length === 0) break;
    // The cursor, not the shrinking missing-set, is what terminates a DRY-RUN pass (nothing
    // gets stamped, so the same page would repeat forever without it).
    afterChunkId = ids[ids.length - 1];
    processed += opts.execute ? await fabFileChunkRepository.backfillCharLengthByIds(ids) : ids.length;
    console.log(`  phase 1: ${opts.execute ? 'stamped' : '[dry-run] would stamp'} ${processed} chunk(s) so far`);
  }
  return processed;
}

async function backfillFiles(opts: Options): Promise<number> {
  let processed = 0;
  let afterFileId: string | undefined;
  for (;;) {
    const ids = await fabFileRepository.findFileIdsMissingChunkedCharCount({ limit: 500, afterFileId });
    if (ids.length === 0) break;
    afterFileId = ids[ids.length - 1];
    for (const id of ids) {
      const total = await fabFileChunkRepository.sumChunkCharLengthByFabFileId(id);
      if (opts.execute) await fabFileRepository.setChunkedCharCount(id, total);
      processed++;
    }
    console.log(`  phase 2: ${opts.execute ? 'stamped' : '[dry-run] would stamp'} ${processed} file(s) so far`);
  }
  return processed;
}

async function recomputeLakes(opts: Options): Promise<number> {
  let scanned = 0;
  // Excludes deleting/deleted lakes: phase-1 delete deliberately freezes their stats so a
  // recoverable lake still shows its pre-delete counts (same exclusion as the
  // recompute-stale-datalake-stats migration).
  const cursor = DataLakeModel.find({ status: { $nin: ['deleting', 'deleted'] } }).cursor();
  for await (const lake of cursor) {
    scanned++;
    if (!opts.execute) continue;
    await dataLakeService.recomputeLakeStats(
      lake,
      { db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository } },
      { skipActivation: true }
    );
  }
  console.log(`  phase 3: ${opts.execute ? 'recomputed' : '[dry-run] would recompute'} ${scanned} lake(s)`);
  return scanned;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);

  console.log('Phase 1: chunk charLength');
  const chunks = await backfillChunks(opts);
  console.log('Phase 2: file chunkedCharCount');
  const files = await backfillFiles(opts);
  console.log('Phase 3: lake totalChunkedChars');
  const lakes = await recomputeLakes(opts);

  console.log(
    `\n${opts.execute ? 'Backfilled' : 'Would backfill'} ${chunks} chunk(s), ${files} file(s); ` +
      `${opts.execute ? 'recomputed' : 'would recompute'} ${lakes} lake(s).`
  );
  return 0;
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 5_000, describe: 'Chunks read per page' })
  .parseSync();

main({ execute: argv.execute, batchSize: argv['batch-size'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @bike4mind/scripts typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/scripts/datalake/backfill-chunk-char-length.ts
git commit -m "feat(data-lake): one-time backfill for chunk charLength and derived rollups"
```

---

### Task 6: full verification

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `pnpm turbo:typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `VITEST_MAX_WORKERS=2 pnpm turbo:test`
Expected: PASS. (The client suite has known floating env flakes; a failure unrelated to these changes should be retried once and reported if persistent.)

- [ ] **Step 3: Lint**

Run: `pnpm lint:check`
Expected: clean.

- [ ] **Step 4: Commit anything the verification required**

Only if Steps 1-3 forced fixes; use a `fix(data-lake): ...` message describing the actual fix.
