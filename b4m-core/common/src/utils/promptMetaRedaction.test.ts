import { describe, it, expect } from 'vitest';
import {
  OWNER_ONLY_FUNCTION_CALL_FIELDS,
  redactFunctionCallsForViewer,
  redactPromptMetaForViewer,
} from './promptMetaRedaction';

describe('redactFunctionCallsForViewer', () => {
  const base = [
    { name: 'web_search', parameters: { query: 'weather' }, id: 'call_1', returnValue: 'SECRET RESULT', success: true },
    { name: 'web_fetch', parameters: {}, id: 'call_2', error: 'SECRET ERROR', success: false },
  ];

  it('strips returnValue and error from every entry', () => {
    const out = redactFunctionCallsForViewer(base);
    expect(out).toBeDefined();
    for (const fc of out!) {
      expect(fc).not.toHaveProperty('returnValue');
      expect(fc).not.toHaveProperty('error');
    }
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('preserves name, parameters, id, and success', () => {
    const out = redactFunctionCallsForViewer(base);
    expect(out).toEqual([
      { name: 'web_search', parameters: { query: 'weather' }, id: 'call_1', success: true },
      { name: 'web_fetch', parameters: {}, id: 'call_2', success: false },
    ]);
  });

  it('does NOT mutate the input', () => {
    const input = [{ ...base[0] }];
    redactFunctionCallsForViewer(input);
    expect(input[0].returnValue).toBe('SECRET RESULT');
  });

  it('passes null/undefined through unchanged', () => {
    expect(redactFunctionCallsForViewer(null)).toBeNull();
    expect(redactFunctionCallsForViewer(undefined)).toBeUndefined();
  });

  it('is a no-op (besides copy) when neither field is present', () => {
    const noSecrets = [{ name: 'web_search', parameters: {}, id: 'call_1', success: true }];
    expect(redactFunctionCallsForViewer(noSecrets)).toEqual(noSecrets);
  });

  it('returns an empty array unchanged', () => {
    expect(redactFunctionCallsForViewer([])).toEqual([]);
  });

  it('keeps OWNER_ONLY_FUNCTION_CALL_FIELDS as the single source of truth', () => {
    expect(OWNER_ONLY_FUNCTION_CALL_FIELDS).toContain('returnValue');
    expect(OWNER_ONLY_FUNCTION_CALL_FIELDS).toContain('error');
  });
});

describe('redactPromptMetaForViewer', () => {
  const promptMeta = {
    model: { name: 'gpt-4' },
    functionCalls: [{ name: 'web_search', parameters: {}, id: 'call_1', returnValue: 'SECRET RESULT', success: true }],
  };

  it('redacts functionCalls for a non-owner', () => {
    const out = redactPromptMetaForViewer(promptMeta, false);
    expect(JSON.stringify(out)).not.toContain('SECRET');
    expect(out?.model).toEqual({ name: 'gpt-4' });
  });

  it('returns the SAME reference for an owner (no needless copy)', () => {
    expect(redactPromptMetaForViewer(promptMeta, true)).toBe(promptMeta);
  });

  it('returns the SAME reference when there are no functionCalls to redact', () => {
    const noCalls = { model: { name: 'gpt-4' } };
    expect(redactPromptMetaForViewer(noCalls, false)).toBe(noCalls);
  });

  it('passes null/undefined through unchanged regardless of isOwner', () => {
    expect(redactPromptMetaForViewer(null, false)).toBeNull();
    expect(redactPromptMetaForViewer(undefined, false)).toBeUndefined();
  });
});

/**
 * Citation chips carry the retrieved passage verbatim since #3038, which is the same class of
 * owner-only content `functionCalls[].returnValue` is: a slice of a document the OWNER's retrieval
 * read. Without this, a session share, subscription, clone or bug-report egress would hand a
 * non-owner readable text out of the owner's corpus.
 */
describe('redactPromptMetaForViewer: citable passage text', () => {
  const withCitable = () => ({
    model: { name: 'gpt-4' },
    citables: [
      {
        id: 'file-1',
        title: 'Leave policy.md',
        metadata: { sourceSystem: 'knowledge_base', chunkId: 'c1', fullContext: 'SECRET PASSAGE', tags: ['hr'] },
      },
    ],
  });

  it('strips fullContext from a citable for a non-owner', () => {
    const out = redactPromptMetaForViewer(withCitable(), false);
    expect(JSON.stringify(out)).not.toContain('SECRET PASSAGE');
  });

  it('keeps the rest of the chip so the citation still renders and still deep-links', () => {
    // chunkId survives on purpose: an opaque id is not content, and the file id beside it was
    // never redacted. Stripping it would break the chip for no privacy gain.
    const out = redactPromptMetaForViewer(withCitable(), false);
    expect(out?.citables?.[0]?.metadata).toEqual({
      sourceSystem: 'knowledge_base',
      chunkId: 'c1',
      tags: ['hr'],
    });
    expect(out?.model).toEqual({ name: 'gpt-4' });
  });

  it('leaves the owner their own passage text', () => {
    const owned = withCitable();
    expect(redactPromptMetaForViewer(owned, true)).toBe(owned);
  });

  it('does not mutate the input, which read paths share with an owner-scoped consumer', () => {
    const input = withCitable();
    redactPromptMetaForViewer(input, false);
    expect(input.citables[0].metadata.fullContext).toBe('SECRET PASSAGE');
  });

  it('returns the SAME reference when no citable carries passage text', () => {
    const fileLevel = {
      model: { name: 'gpt-4' },
      citables: [{ id: 'file-1', metadata: { sourceSystem: 'knowledge_base', relevanceScore: 0.9 } }],
    };
    // The whole promptMeta, not just the chip: the documented contract is that a viewer read with
    // nothing to redact costs no copy at all.
    expect(redactPromptMetaForViewer(fileLevel, false)).toBe(fileLevel);
  });

  it('redacts citables even when the turn made no function calls', () => {
    // The early return used to bail on `!functionCalls`, which would have skipped citables
    // entirely on a forced-retrieval turn - the one that ALWAYS emits them.
    const out = redactPromptMetaForViewer(withCitable(), false);
    expect(out?.citables?.[0]?.metadata?.fullContext).toBeUndefined();
  });
});
