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
