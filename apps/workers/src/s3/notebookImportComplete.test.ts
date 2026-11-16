import { describe, it, expect, vi } from 'vitest';

// infra/buckets.ts names `apps/workers/src/s3/notebookImportComplete.dispatch`; the handler-string
// guard in checkWorkersMovedDirs.test.ts cannot see whether the export is really there.
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/s3/notebookImportComplete', () => ({ dispatch }));

import * as entry from './notebookImportComplete';

describe('NotebookImportCompleteFunction Lambda entry', () => {
  it('re-exports the server-utils dispatch as the handler infra names', () => {
    expect(entry.dispatch).toBe(dispatch);
  });
});
