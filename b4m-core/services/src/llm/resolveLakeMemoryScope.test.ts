import { describe, expect, it } from 'vitest';
import { resolveLakeMemoryScope } from './resolveLakeMemoryScope';

const ENTITLED = ['datalake:acme', 'datalake:other'];

describe('resolveLakeMemoryScope', () => {
  it('narrows to the selected lakes, dropping a tag the user is not entitled to', () => {
    expect(
      resolveLakeMemoryScope({
        entitledTags: ENTITLED,
        retrievalTags: ['datalake:acme', 'datalake:notmine'],
        lakeScopeExplicit: true,
      })
    ).toEqual(['datalake:acme']);
  });

  it('falls back to the full entitled set when no scope was ever expressed', () => {
    expect(resolveLakeMemoryScope({ entitledTags: ENTITLED, retrievalTags: [], lakeScopeExplicit: undefined })).toEqual(
      ENTITLED
    );
    expect(
      resolveLakeMemoryScope({ entitledTags: ENTITLED, retrievalTags: undefined, lakeScopeExplicit: undefined })
    ).toEqual(ENTITLED);
  });

  it('selects NO lake when the scope is explicit and empty', () => {
    // The whole point of the flag: "the user deselected every lake" must not read as "no scoping
    // wanted", which is what an empty array alone says.
    expect(resolveLakeMemoryScope({ entitledTags: ENTITLED, retrievalTags: [], lakeScopeExplicit: true })).toEqual([]);
  });

  it('treats an explicit scope of non-lake tags as selecting no lake', () => {
    // A content tag (`mock:breast`) names no lake, so the intersection is empty - unchanged
    // behavior, pinned here because the explicit flag must not turn it into a widening fallback.
    expect(
      resolveLakeMemoryScope({ entitledTags: ENTITLED, retrievalTags: ['mock:breast'], lakeScopeExplicit: true })
    ).toEqual([]);
  });

  it('ignores the flag when lakes are selected, explicit or not', () => {
    expect(
      resolveLakeMemoryScope({
        entitledTags: ENTITLED,
        retrievalTags: ['datalake:other'],
        lakeScopeExplicit: undefined,
      })
    ).toEqual(['datalake:other']);
  });
});
