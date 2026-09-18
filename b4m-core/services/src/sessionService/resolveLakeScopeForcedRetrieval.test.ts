import { describe, it, expect } from 'vitest';

import { resolveLakeScopeForcedRetrieval } from './resolveLakeScopeForcedRetrieval';

const LAKE = ['datalake:acme'];

describe('resolveLakeScopeForcedRetrieval', () => {
  it('implies forced retrieval for a session explicitly scoped to a lake', () => {
    expect(
      resolveLakeScopeForcedRetrieval({
        forceKnowledgeRetrieval: undefined,
        retrievalTags: LAKE,
        lakeScopeExplicit: true,
      })
    ).toBe(true);
  });

  it('honors an explicit opt-out over the implication', () => {
    expect(
      resolveLakeScopeForcedRetrieval({
        forceKnowledgeRetrieval: false,
        retrievalTags: LAKE,
        lakeScopeExplicit: true,
      })
    ).toBe(false);
  });

  it('leaves the field unset when nothing applies, rather than writing an explicit off', () => {
    expect(
      resolveLakeScopeForcedRetrieval({
        forceKnowledgeRetrieval: undefined,
        retrievalTags: undefined,
        lakeScopeExplicit: undefined,
      })
    ).toBeUndefined();
  });

  it('does not force an explicit scope that selected NO lake', () => {
    // Forcing here would force retrieval against nothing - the scope's tag clause matches no lake.
    for (const retrievalTags of [undefined, []]) {
      expect(
        resolveLakeScopeForcedRetrieval({ forceKnowledgeRetrieval: undefined, retrievalTags, lakeScopeExplicit: true })
      ).toBeUndefined();
    }
  });

  it('does not force tags with no explicit marker - those can be derived from an attached file', () => {
    expect(
      resolveLakeScopeForcedRetrieval({
        forceKnowledgeRetrieval: undefined,
        retrievalTags: LAKE,
        lakeScopeExplicit: undefined,
      })
    ).toBeUndefined();
  });

  it('passes an explicit ON through unchanged', () => {
    expect(
      resolveLakeScopeForcedRetrieval({
        forceKnowledgeRetrieval: true,
        retrievalTags: undefined,
        lakeScopeExplicit: undefined,
      })
    ).toBe(true);
  });
});
