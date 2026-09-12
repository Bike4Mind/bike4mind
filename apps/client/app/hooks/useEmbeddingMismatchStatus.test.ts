// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { IFabFileDocument } from '@bike4mind/common';

let workBenchFiles: Partial<IFabFileDocument>[] = [];
let systemFiles: Partial<IFabFileDocument>[] = [];
let effectiveEmbeddingModel: string | undefined;

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useWorkBenchFiles: () => workBenchFiles,
  useSystemPromptFiles: () => ({ systemFiles }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useEffectiveEmbeddingModel: () => effectiveEmbeddingModel,
}));

import { useEmbeddingMismatchStatus } from './useEmbeddingMismatchStatus';

const file = (id: string, embeddingModel?: string) => ({ id, embeddingModel }) as Partial<IFabFileDocument>;

const ADA = 'text-embedding-ada-002';
const TITAN = 'amazon.titan-embed-text-v2:0';

describe('useEmbeddingMismatchStatus', () => {
  beforeEach(() => {
    workBenchFiles = [];
    systemFiles = [];
    effectiveEmbeddingModel = undefined;
  });

  const render = () => renderHook(() => useEmbeddingMismatchStatus('s1')).result.current;

  it('flags a file whose vectors are in a different space than the one this stage queries with', () => {
    effectiveEmbeddingModel = ADA;
    workBenchFiles = [file('w1', TITAN)];

    expect(render()).toBe(true);
  });

  it('does NOT flag a file that matches the EFFECTIVE model, even though it differs from the advertised default', () => {
    // The regression this pins. On a keyless stage the vectorizer falls back to Titan and stamps the
    // corpus Titan, while `defaultEmbeddingModel` deliberately keeps advertising ada-002 (it is
    // bundled into this browser build and must stay stage-neutral). Comparing against the advertised
    // value reddened the session-toolbar file count for an entire library of healthy files, and the
    // per-file reprocess it invites just re-runs the same fallback and re-stamps the same label.
    effectiveEmbeddingModel = TITAN;
    workBenchFiles = [file('w1', TITAN), file('w2', TITAN)];

    expect(render()).toBe(false);
  });

  it('reports no mismatch while the effective model is unknown, rather than guessing', () => {
    // Unknown means either "config has not loaded yet" or "this deployment cannot embed at all".
    // Neither justifies a badge, and falling back to the advertised setting here is exactly the
    // substitution that produced the false positive above.
    effectiveEmbeddingModel = undefined;
    workBenchFiles = [file('w1', TITAN)];

    expect(render()).toBe(false);
  });

  it('ignores an unlabeled file, whose space is simply unknown', () => {
    effectiveEmbeddingModel = ADA;
    workBenchFiles = [file('w1', undefined)];

    expect(render()).toBe(false);
  });

  it('checks system files as well as workbench files', () => {
    effectiveEmbeddingModel = ADA;
    systemFiles = [file('sys1', TITAN)];

    expect(render()).toBe(true);
  });
});
