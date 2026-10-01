import { describe, it, expect } from 'vitest';
import { diagnoseAnswer, HEALTHY_VERDICT_BODY, type DiagnosisCheckId, type DiagnosisStatus } from './answerDiagnosis';
import type { PromptMeta } from '../types/entities/PromptMetaTypes';

const statusOf = (promptMeta: PromptMeta, id: DiagnosisCheckId): DiagnosisStatus =>
  diagnoseAnswer(promptMeta).checks.find(c => c.id === id)!.status;

const detailOf = (promptMeta: PromptMeta, id: DiagnosisCheckId): string =>
  diagnoseAnswer(promptMeta).checks.find(c => c.id === id)!.detail;

/** A turn where every bucket passed - the baseline the problem cases deviate from. */
const healthy: PromptMeta = {
  retrieval: {
    attempted: true,
    outcome: 'ok',
    surfaces: ['lake-memory'],
    dataLakeTags: ['handbook'],
    injected: { chunks: 4, chars: 2000 },
  },
  context: { messageTruncation: { wasTruncated: false, originalMessageCount: 10, truncatedMessageCount: 10 } },
  functionCalls: [{ name: 'search_knowledge_base', success: true }],
};

describe('diagnoseAnswer', () => {
  it('always returns all four checks, in checklist order', () => {
    expect(diagnoseAnswer({}).checks.map(c => c.id)).toEqual(['retrieval', 'context', 'tools', 'corpus']);
    expect(diagnoseAnswer(healthy).checks.map(c => c.id)).toEqual(['retrieval', 'context', 'tools', 'corpus']);
  });

  it('gives the model-reasoning verdict when nothing in the pipeline went wrong', () => {
    const diagnosis = diagnoseAnswer(healthy);
    expect(diagnosis.verdict.status).toBe('ok');
    expect(diagnosis.verdict.body).toBe(HEALTHY_VERDICT_BODY);
  });

  it('names the failing buckets in the verdict rather than burying them in the list', () => {
    const diagnosis = diagnoseAnswer({ ...healthy, functionCalls: [{ name: 'web_search', success: false }] });
    expect(diagnosis.verdict.status).toBe('fail');
    expect(diagnosis.verdict.body).toContain('Tools');
  });
});

describe('retrieval check', () => {
  it('reports an absent summary as unknown, not as a failure', () => {
    expect(statusOf({}, 'retrieval')).toBe('unknown');
    expect(detailOf({}, 'retrieval')).toContain('No retrieval was recorded');
  });

  it('treats attempted: false as a recorded fact about the optional path', () => {
    const meta: PromptMeta = {
      retrieval: { attempted: false, mode: 'optional', surfaces: [], dataLakeTags: [] },
    };
    expect(statusOf(meta, 'retrieval')).toBe('warn');
    expect(detailOf(meta, 'retrieval')).toContain('chose not to search');
  });

  it('names the suppression when a forced turn was skipped', () => {
    const meta: PromptMeta = {
      retrieval: {
        attempted: false,
        mode: 'forced',
        forcedSkipReason: 'attached_files',
        surfaces: [],
        dataLakeTags: [],
      },
    };
    expect(detailOf(meta, 'retrieval')).toContain('files attached to this message');
  });

  it.each([
    ['failed' as const, 'fail' as const],
    ['no_lakes' as const, 'warn' as const],
    ['not_indexed' as const, 'fail' as const],
  ])('maps outcome %s to %s with its own remedy', (outcome, status) => {
    const meta: PromptMeta = { retrieval: { attempted: true, outcome, surfaces: [], dataLakeTags: [] } };
    const check = diagnoseAnswer(meta).checks.find(c => c.id === 'retrieval')!;
    expect(check.status).toBe(status);
    expect(check.remedy).toBeTruthy();
  });

  it('separates an unrecorded volume from a recorded starve', () => {
    const unknownVolume: PromptMeta = { retrieval: { attempted: true, outcome: 'ok', surfaces: [], dataLakeTags: [] } };
    expect(statusOf(unknownVolume, 'retrieval')).toBe('unknown');
    expect(detailOf(unknownVolume, 'retrieval')).toContain('not recorded');

    const starve: PromptMeta = {
      retrieval: { attempted: true, outcome: 'ok', surfaces: [], dataLakeTags: [], injected: { chunks: 0, chars: 0 } },
    };
    expect(statusOf(starve, 'retrieval')).toBe('fail');
    expect(detailOf(starve, 'retrieval')).toContain('nothing was retrieved');
  });

  it('does not call a recorded zero a starve while an uninstrumented content tool also ran', () => {
    const meta: PromptMeta = {
      retrieval: { attempted: true, outcome: 'ok', surfaces: [], dataLakeTags: [], injected: { chunks: 0, chars: 0 } },
      functionCalls: [{ name: 'retrieve_knowledge_content', success: true }],
    };
    expect(statusOf(meta, 'retrieval')).toBe('unknown');
  });

  it('adds the document count only when citables carry one', () => {
    expect(detailOf(healthy, 'retrieval')).toBe('4 passages reached the model.');
    const withDocs: PromptMeta = {
      ...healthy,
      citables: [
        { id: 'a', type: 'document', title: 'A' },
        { id: 'b', type: 'document', title: 'B' },
        { id: 'c', type: 'web_url', title: 'C' },
      ],
    };
    expect(detailOf(withDocs, 'retrieval')).toBe('4 passages from 2 documents reached the model.');
  });

  // The shape of a real lake-memory turn under a floor that starved forced retrieval: without the
  // attribution the panel reads "6 passages" against a floor that admitted none of them.
  it('says forced retrieval contributed nothing when its candidate pool was empty', () => {
    const meta: PromptMeta = {
      retrieval: {
        attempted: true,
        outcome: 'ok',
        surfaces: ['lake-memory', 'forced-retrieval'],
        dataLakeTags: ['handbook'],
        dataLakeTagsWithCandidates: [],
        injected: {
          chunks: 6,
          chars: 1029,
          topScore: 0.7197,
          preRelativeFloorCandidates: 0,
          postRelativeFloorCandidates: 0,
          postSpreadFloorCandidates: 0,
        },
      },
    };
    expect(detailOf(meta, 'retrieval')).toBe(
      '6 passages reached the model. None came from forced retrieval, which admitted no passage past its similarity floors. Other surfaces that ran this turn: lake memory.'
    );
  });

  it('treats an empty spread-floor pool as an empty forced contribution even when earlier stages had candidates', () => {
    const meta: PromptMeta = {
      retrieval: {
        attempted: true,
        outcome: 'ok',
        surfaces: ['forced-retrieval', 'lake-memory', 'knowledgeBaseSearch'],
        dataLakeTags: [],
        injected: {
          chunks: 3,
          chars: 900,
          preRelativeFloorCandidates: 5,
          postRelativeFloorCandidates: 2,
          postSpreadFloorCandidates: 0,
        },
      },
    };
    expect(detailOf(meta, 'retrieval')).toContain(
      'Other surfaces that ran this turn: lake memory and the knowledge base search tool.'
    );
  });

  it('names a mixed total as mixed when forced retrieval may have contributed', () => {
    const meta: PromptMeta = {
      retrieval: {
        attempted: true,
        outcome: 'ok',
        surfaces: ['forced-retrieval', 'lake-memory'],
        dataLakeTags: [],
        injected: { chunks: 6, chars: 1029, preRelativeFloorCandidates: 4, postRelativeFloorCandidates: 3 },
      },
    };
    expect(detailOf(meta, 'retrieval')).toBe(
      '6 passages reached the model. That total sums every surface that ran this turn (forced retrieval and lake memory), not only forced retrieval.'
    );
  });

  it('does not throw on a stored turn that carries no surfaces', () => {
    const legacy = { retrieval: { attempted: true, outcome: 'ok', injected: { chunks: 2, chars: 400 } } };
    expect(detailOf(legacy as unknown as PromptMeta, 'retrieval')).toBe('2 passages reached the model.');
  });

  it('does not attribute a forced-only turn, whose pool bounds its own total', () => {
    const meta: PromptMeta = {
      retrieval: {
        attempted: true,
        outcome: 'ok',
        surfaces: ['forced-retrieval'],
        dataLakeTags: [],
        injected: { chunks: 2, chars: 400, preRelativeFloorCandidates: 2, postRelativeFloorCandidates: 2 },
      },
    };
    expect(detailOf(meta, 'retrieval')).toBe('2 passages reached the model.');
  });
});

// A session naming a draft lake narrows to an empty scope, so the forced arm abstains with
// 'no_lakes' while search_knowledge_base runs over nothing and writes 'ok' with zero chunks. The
// merge keeps 'ok', so the stored turn is exactly this shape.
describe("scope abstain (the chat's lake was never searched)", () => {
  const draftAbstain: PromptMeta = {
    retrieval: {
      attempted: true,
      outcome: 'ok',
      mode: 'forced',
      surfaces: ['forced-retrieval', 'knowledgeBaseSearch'],
      dataLakeTags: [],
      injected: { chunks: 0, chars: 0 },
      lakeScope: [],
      notServingLakes: { count: 1, reason: 'draft' },
      excludedLakes: { count: 0, reason: 'access' },
    },
  };
  const withRetrieval = (over: Partial<NonNullable<PromptMeta['retrieval']>>): PromptMeta => ({
    retrieval: { ...draftAbstain.retrieval!, ...over },
  });
  const retrievalCheck = (meta: PromptMeta) => diagnoseAnswer(meta).checks.find(c => c.id === 'retrieval')!;

  it('names the draft as the cause instead of reporting a broken pipeline', () => {
    const diagnosis = diagnoseAnswer(draftAbstain);
    const check = retrievalCheck(draftAbstain);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('is a draft');
    expect(check.remedy).toContain('Publish the lake');
    expect(diagnosis.verdict.status).toBe('warn');
    expect(diagnosis.verdict.headline).toBe('The model may not have had what it needed');
    expect(diagnosis.verdict.body).toContain('Retrieval');
  });

  it("does not call the lake that was never searched 'searchable'", () => {
    expect(statusOf(draftAbstain, 'corpus')).toBe('unknown');
    expect(detailOf(draftAbstain, 'corpus')).not.toContain('searchable');
  });

  it('gives the same answer when the merged outcome kept the abstain', () => {
    const meta = withRetrieval({ outcome: 'no_lakes', injected: undefined });
    expect(retrievalCheck(meta).status).toBe('warn');
    expect(retrievalCheck(meta).detail).toContain('is a draft');
  });

  it('names an access exclusion when no draft explains the empty scope', () => {
    const meta = withRetrieval({
      notServingLakes: { count: 0, reason: 'draft' },
      excludedLakes: { count: 1, reason: 'access' },
    });
    expect(retrievalCheck(meta).status).toBe('warn');
    expect(retrievalCheck(meta).detail).toContain('not one you can currently reach');
    expect(retrievalCheck(meta).remedy).toContain('access');
  });

  it('keeps a real failure on whatever did run as the headline', () => {
    expect(retrievalCheck(withRetrieval({ outcome: 'failed' })).status).toBe('fail');
    expect(retrievalCheck(withRetrieval({ outcome: 'not_indexed' })).status).toBe('fail');
  });

  it('still fails a genuine zero over a lake that was in scope', () => {
    const meta = withRetrieval({ lakeScope: ['datalake:handbook'] });
    expect(retrievalCheck(meta).status).toBe('fail');
    expect(retrievalCheck(meta).detail).toContain('nothing was retrieved');
  });

  it('still fails an empty scope with no recorded cause, rather than guessing one', () => {
    const meta = withRetrieval({ notServingLakes: undefined, excludedLakes: undefined });
    expect(retrievalCheck(meta).status).toBe('fail');
  });
});

describe('corpus check', () => {
  it('is driven off not_indexed directly', () => {
    const meta: PromptMeta = { retrieval: { attempted: true, outcome: 'not_indexed', surfaces: [], dataLakeTags: [] } };
    expect(statusOf(meta, 'corpus')).toBe('fail');
    expect(detailOf(meta, 'corpus')).toContain('no usable search index');
  });

  it('is unknown when no search ran, and ok when one did', () => {
    expect(statusOf({}, 'corpus')).toBe('unknown');
    expect(statusOf({ retrieval: { attempted: false, surfaces: [], dataLakeTags: [] } }, 'corpus')).toBe('unknown');
    expect(statusOf(healthy, 'corpus')).toBe('ok');
  });

  it('is unknown, not searchable, when no knowledge base was in scope', () => {
    const meta: PromptMeta = { retrieval: { attempted: true, outcome: 'no_lakes', surfaces: [], dataLakeTags: [] } };
    expect(statusOf(meta, 'corpus')).toBe('unknown');
    expect(detailOf(meta, 'corpus')).not.toContain('searchable');
  });
});

describe('context check', () => {
  it('reports the dropped share, not the surviving one', () => {
    const meta: PromptMeta = {
      context: {
        messageTruncation: { wasTruncated: true, originalMessageCount: 40, truncatedMessageCount: 10 },
      },
    };
    expect(statusOf(meta, 'context')).toBe('warn');
    expect(detailOf(meta, 'context')).toContain('75 percent');
  });

  it('falls back to context-window overflow when truncation was not recorded', () => {
    const meta: PromptMeta = {
      context: {
        contextWindowUsage: {
          contextLimit: 1000,
          maxOutputTokens: 100,
          safeMaxInputTokens: 900,
          actualInputTokens: 950,
          bufferTokens: 0,
          utilizationPercentage: 105,
          overflowDetected: true,
        },
      },
    };
    expect(statusOf(meta, 'context')).toBe('warn');
  });

  it('is unknown when nothing about context assembly was recorded', () => {
    expect(statusOf({}, 'context')).toBe('unknown');
  });
});

describe('tools check', () => {
  it('separates "no tools ran" from "no tool detail recorded"', () => {
    expect(statusOf({ functionCalls: [] }, 'tools')).toBe('ok');
    expect(statusOf({}, 'tools')).toBe('unknown');
  });

  it('counts a recorded error as a failure and names the tool', () => {
    const meta: PromptMeta = {
      functionCalls: [
        { name: 'web_search', error: 'timeout' },
        { name: 'math_evaluate', success: true },
      ],
    };
    expect(statusOf(meta, 'tools')).toBe('fail');
    expect(detailOf(meta, 'tools')).toContain('web_search');
  });

  it('does not count a call with no recorded verdict as failed', () => {
    expect(statusOf({ functionCalls: [{ name: 'web_search' }] }, 'tools')).toBe('ok');
  });
});
