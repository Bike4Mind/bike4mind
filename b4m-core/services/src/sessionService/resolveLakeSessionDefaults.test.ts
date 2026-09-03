import { describe, it, expect } from 'vitest';
import type { IDataLake } from '@bike4mind/common';
import { resolveLakeSessionDefaults } from './resolveLakeSessionDefaults';

type LakeInput = Pick<IDataLake, 'datalakeTag' | 'preferredSystemPromptId' | 'groundingMode'>;

describe('resolveLakeSessionDefaults', () => {
  it('binds the preferred prompt AND scopes retrieval to the lake when both are present', () => {
    const lake: LakeInput = { datalakeTag: 'datalake:acme', preferredSystemPromptId: 'triage_router' };
    expect(resolveLakeSessionDefaults(lake)).toEqual({
      forceKnowledgeRetrieval: true,
      retrievalTags: ['datalake:acme'],
      systemPromptId: 'triage_router',
      // Always set for a lake session; absent stored mode -> the default.
      corpusGroundingMode: 'retrieve',
    });
  });

  it('omits systemPromptId entirely when the lake declares no preferred prompt', () => {
    const lake: LakeInput = { datalakeTag: 'datalake:acme', preferredSystemPromptId: undefined };
    const result = resolveLakeSessionDefaults(lake);
    expect(result).toEqual({
      forceKnowledgeRetrieval: true,
      retrievalTags: ['datalake:acme'],
      corpusGroundingMode: 'retrieve',
    });
    // Absent, not undefined-valued: the caller merges this under the request, and a present
    // `systemPromptId: undefined` would clobber an explicit request value under object spread.
    expect('systemPromptId' in result).toBe(false);
  });

  it('treats an empty-string preferred prompt as "no binding"', () => {
    const lake: LakeInput = { datalakeTag: 'datalake:acme', preferredSystemPromptId: '' };
    expect('systemPromptId' in resolveLakeSessionDefaults(lake)).toBe(false);
  });

  it('omits retrievalTags when the lake has no join tag (defensive for registry fallbacks)', () => {
    const lake = { datalakeTag: '', preferredSystemPromptId: 'triage_router' } as LakeInput;
    const result = resolveLakeSessionDefaults(lake);
    expect('retrievalTags' in result).toBe(false);
    // Still forces retrieval and binds the prompt - only the single-lake scope is dropped.
    expect(result).toEqual({
      forceKnowledgeRetrieval: true,
      systemPromptId: 'triage_router',
      corpusGroundingMode: 'retrieve',
    });
  });

  // Grounding mode: ALWAYS resolved onto the session (unlike the opt-in prompt/tag fields), so an
  // owner and an entitlement-only reader of the same lake ground identically.
  it('defaults grounding mode to retrieve when the lake never set it (incl. lakes predating the field)', () => {
    const lake: LakeInput = { datalakeTag: 'datalake:acme' };
    expect(resolveLakeSessionDefaults(lake).corpusGroundingMode).toBe('retrieve');
  });

  it('carries an explicit grounding mode through verbatim', () => {
    expect(
      resolveLakeSessionDefaults({ datalakeTag: 'datalake:acme', groundingMode: 'inline' }).corpusGroundingMode
    ).toBe('inline');
    expect(
      resolveLakeSessionDefaults({ datalakeTag: 'datalake:acme', groundingMode: 'auto-by-size' }).corpusGroundingMode
    ).toBe('auto-by-size');
  });

  it('always sets corpusGroundingMode (a lake session is never left in the size-only branch)', () => {
    const result = resolveLakeSessionDefaults({ datalakeTag: 'datalake:acme' });
    expect('corpusGroundingMode' in result).toBe(true);
  });
});
