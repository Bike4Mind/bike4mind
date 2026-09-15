import { describe, it, expect } from 'vitest';
import { Session } from './SessionModel';

// The Session schema is strict (Mongoose default), so any field NOT declared here is
// silently dropped on save. The generic retrieval-exclusion capability persists these two
// session fields; if they fall out of the schema they never reach the DB and the whole
// feature no-ops silently (retrieval keeps surfacing files a surface's listing hides).
// This guards the schema half of that contract - keep in sync with ISession / the zod
// create schema in b4m-core/services/src/sessionService/create.ts.
describe('SessionModel retrieval-exclusion fields are persisted (not stripped by strict mode)', () => {
  it('declares retrievalExcludeFilenameMarkers as a string array path', () => {
    const path = Session.schema.path('retrievalExcludeFilenameMarkers');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Array');
  });

  it('declares retrievalVectorizedOnly as a boolean path', () => {
    const path = Session.schema.path('retrievalVectorizedOnly');
    expect(path).toBeDefined();
    expect(path.instance).toBe('Boolean');
  });
});
