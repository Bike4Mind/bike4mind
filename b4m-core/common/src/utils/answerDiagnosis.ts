import type { PromptMeta } from '../types/entities/PromptMetaTypes';

/**
 * Per-turn answer diagnosis (#1872): the full checklist behind "why was this answer bad?".
 *
 * Deliberately reports a row for EVERY bucket, including the ones that passed. A panel that lists
 * only problems reads as "we don't know" when it comes up empty, and the honest "everything the
 * pipeline controls was healthy, so this is on the model" verdict is the one that lets a rollup
 * say: of N negative reports, X had zero retrieval and Y had healthy context.
 *
 * Pure and free of React so the same fold can run over a batch of quests server-side. Reads only
 * `promptMeta`; the `LakeAccessEvent` ledger is enrichment and is never joined here - it counts a
 * dispatched subagent's lake reads against the PARENT's turn, so it routinely exceeds what
 * `promptMeta.retrieval` corroborates, and letting it drive a verdict would make the verdict
 * disagree with the contract it claims to summarize.
 */

/**
 * 'unknown' is a first-class arm, not a fallback: an unrecorded volume and a recorded zero are
 * different answers, and collapsing them produces the confident-wrong-answer this panel exists to
 * catch.
 */
export type DiagnosisStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export type DiagnosisCheckId = 'retrieval' | 'context' | 'tools' | 'corpus';

export type DiagnosisCheck = {
  id: DiagnosisCheckId;
  label: string;
  status: DiagnosisStatus;
  /** What was recorded, in the reader's terms. Always present. */
  detail: string;
  /** What to do about it. Absent when there is nothing for the reader to do. */
  remedy?: string;
};

export type AnswerDiagnosis = {
  /** Always four rows, in checklist order, whatever the turn recorded. */
  checks: DiagnosisCheck[];
  verdict: {
    status: DiagnosisStatus;
    headline: string;
    body: string;
  };
};

/**
 * Injects retrieved text but reports no volume, so its presence is what keeps a recorded
 * `injected.chunks === 0` from being rendered as proof of a starve. See the KNOWN HOLE note on
 * `injected` in promptMeta.ts: the forced arm can complete empty and write an honest zero while
 * the model grounds the same turn through this tool, which contributes nothing to oppose it.
 */
const UNINSTRUMENTED_CONTENT_TOOL = 'retrieve_knowledge_content';

const SEVERITY: Record<DiagnosisStatus, number> = { fail: 3, warn: 2, unknown: 1, ok: 0 };

const worstOf = (statuses: DiagnosisStatus[]): DiagnosisStatus =>
  statuses.reduce<DiagnosisStatus>((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), 'ok');

const FORCED_SKIP_COPY: Record<'attached_files' | 'personal_corpus', string> = {
  attached_files: 'files attached to this message took priority over a library search',
  personal_corpus: 'the personal corpus path took priority over a library search',
};

const countDocuments = (promptMeta: PromptMeta): number =>
  promptMeta.citables?.filter(c => c.type === 'document').length ?? 0;

const groundedThroughUninstrumentedTool = (promptMeta: PromptMeta): boolean =>
  !!promptMeta.functionCalls?.some(call => call.name === UNINSTRUMENTED_CONTENT_TOOL);

function diagnoseRetrieval(promptMeta: PromptMeta): DiagnosisCheck {
  const label = 'Retrieval';
  const retrieval = promptMeta.retrieval;

  // Absence is not "retrieval failed": the summary is seeded on every turn that COULD have
  // retrieved, so no field at all means no knowledge was in scope (or the turn predates the seed).
  if (!retrieval) {
    return {
      id: 'retrieval',
      label,
      status: 'unknown',
      detail:
        'No retrieval was recorded for this turn - either no knowledge base was in scope, or this turn predates retrieval recording.',
    };
  }

  if (!retrieval.attempted) {
    const skip = retrieval.forcedSkipReason;
    if (skip) {
      return {
        id: 'retrieval',
        label,
        status: 'warn',
        detail: `Retrieval was configured but skipped: ${FORCED_SKIP_COPY[skip]}.`,
        remedy: 'Ask again without the attachment, or in a session whose knowledge base holds the material.',
      };
    }
    return {
      id: 'retrieval',
      label,
      status: 'warn',
      detail:
        retrieval.mode === 'optional'
          ? 'Retrieval was available and the model chose not to search your knowledge base.'
          : 'Retrieval was available but never ran on this turn.',
      remedy: 'Ask the question so it clearly refers to your documents, or turn on forced retrieval for this session.',
    };
  }

  switch (retrieval.outcome) {
    case 'failed':
      return {
        id: 'retrieval',
        label,
        status: 'fail',
        detail: 'Retrieval did not complete - it errored, or search is not wired up on this host.',
        remedy:
          'Retry. If it keeps happening, this is an outage or a host-configuration fix - re-indexing will not help.',
      };
    case 'no_lakes':
      return {
        id: 'retrieval',
        label,
        status: 'warn',
        detail: 'Retrieval ran but no knowledge base was in scope for it to search.',
        remedy: 'Select a data lake for this session, or check that you still have access to one.',
      };
    case 'not_indexed':
      return {
        id: 'retrieval',
        label,
        status: 'fail',
        detail: 'Retrieval ran but compared nothing - see Corpus below.',
        remedy: 'Re-vectorize the documents in scope; retrying this question will not change the result.',
      };
    case 'ok':
      return diagnoseVolume(promptMeta, retrieval);
    default:
      // outcome is present iff attempted is true, so this is a turn written by a producer that
      // does not yet honor that contract rather than a state the schema admits.
      return {
        id: 'retrieval',
        label,
        status: 'unknown',
        detail: 'Retrieval ran but recorded no outcome.',
      };
  }
}

function diagnoseVolume(promptMeta: PromptMeta, retrieval: NonNullable<PromptMeta['retrieval']>): DiagnosisCheck {
  const label = 'Retrieval';
  const injected = retrieval.injected;

  if (!injected) {
    return {
      id: 'retrieval',
      label,
      status: 'unknown',
      detail: 'Retrieval ran, but how much reached the model was not recorded.',
    };
  }

  if (injected.chunks === 0) {
    if (groundedThroughUninstrumentedTool(promptMeta)) {
      return {
        id: 'retrieval',
        label,
        status: 'unknown',
        detail:
          'The surfaces that report volume injected nothing, but a knowledge tool that reports no volume also ran - so this turn may still have been grounded.',
      };
    }
    return {
      id: 'retrieval',
      label,
      status: 'fail',
      detail:
        'Your knowledge base was searched and nothing was retrieved - the answer is not grounded in your documents.',
      remedy: 'Rephrase with the wording your documents use, or widen the knowledge base in scope.',
    };
  }

  const passages = `${injected.chunks} ${injected.chunks === 1 ? 'passage' : 'passages'}`;
  // Document count is enrichment from `citables` (deduped by id at write time), not a turn-local
  // retrieval field - `retrieval` deliberately carries no document count. Omitted rather than
  // reported as zero when nothing citable was recorded.
  const documents = countDocuments(promptMeta);
  const from = documents > 0 ? ` from ${documents} ${documents === 1 ? 'document' : 'documents'}` : '';

  return {
    id: 'retrieval',
    label,
    status: 'ok',
    detail: `${passages}${from} reached the model.`,
  };
}

function diagnoseCorpus(promptMeta: PromptMeta): DiagnosisCheck {
  const label = 'Corpus';
  const outcome = promptMeta.retrieval?.outcome;

  if (outcome === 'not_indexed') {
    return {
      id: 'corpus',
      label,
      status: 'fail',
      detail:
        'The documents in scope carry no usable search index, so not one passage was compared against your question.',
      remedy: 'Re-vectorize those documents. A blank result here is not evidence your library lacks the answer.',
    };
  }

  if (!outcome) {
    return {
      id: 'corpus',
      label,
      status: 'unknown',
      detail: 'No search ran, so nothing is known about whether the documents in scope are indexed.',
    };
  }

  return {
    id: 'corpus',
    label,
    status: 'ok',
    detail: 'The documents in scope were searchable.',
  };
}

function diagnoseContext(promptMeta: PromptMeta): DiagnosisCheck {
  const label = 'Context';
  const truncation = promptMeta.context?.messageTruncation;
  const usage = promptMeta.context?.contextWindowUsage;

  if (truncation?.wasTruncated) {
    // `truncatedMessageCount` is the count that SURVIVED (utils.ts buildDebugInfo), so the dropped
    // share is the complement - naming it "truncated" the other way round would invert the percent.
    const dropped = Math.max(0, truncation.originalMessageCount - truncation.truncatedMessageCount);
    const percent =
      truncation.originalMessageCount > 0 ? Math.round((dropped / truncation.originalMessageCount) * 100) : 0;
    return {
      id: 'context',
      label,
      status: 'warn',
      detail: `${percent} percent of the conversation was dropped to fit the context window (${dropped} of ${truncation.originalMessageCount} messages).`,
      remedy: 'Start a fresh session, or restate the details the answer needed.',
    };
  }

  if (truncation) {
    return { id: 'context', label, status: 'ok', detail: 'The whole conversation fit - nothing was truncated.' };
  }

  if (usage?.overflowDetected) {
    return {
      id: 'context',
      label,
      status: 'warn',
      detail: 'The assembled prompt overflowed the context window and had to be rebuilt smaller.',
      remedy: 'Start a fresh session, or attach fewer files.',
    };
  }

  if (usage) {
    return { id: 'context', label, status: 'ok', detail: 'The prompt fit inside the context window.' };
  }

  return { id: 'context', label, status: 'unknown', detail: 'No context-assembly detail was recorded for this turn.' };
}

function diagnoseTools(promptMeta: PromptMeta): DiagnosisCheck {
  const label = 'Tools';
  const calls = promptMeta.functionCalls;

  if (!calls) {
    return { id: 'tools', label, status: 'unknown', detail: 'No tool-call detail was recorded for this turn.' };
  }

  if (calls.length === 0) {
    return { id: 'tools', label, status: 'ok', detail: 'No tools ran this turn.' };
  }

  // `success` is optional: a call that recorded neither a verdict nor an error is not counted as a
  // failure, because reporting an unrecorded call as failed sends readers after a bug that is not
  // there.
  const failed = calls.filter(call => call.success === false || !!call.error);
  if (failed.length > 0) {
    const names = failed.map(call => call.name).filter((n): n is string => !!n);
    const named = names.length > 0 ? ` (${names.join(', ')})` : '';
    return {
      id: 'tools',
      label,
      status: 'fail',
      detail: `${failed.length} of ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'} failed${named}.`,
      remedy:
        'Retry the question; a failed tool usually means the answer was written without what that tool would have returned.',
    };
  }

  return {
    id: 'tools',
    label,
    status: 'ok',
    detail: `${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}, all succeeded.`,
  };
}

/**
 * Panel heading, and the label of the menu item that opens it. Shared so the entry point and the
 * panel cannot drift into naming the same surface two different things.
 */
export const ANSWER_DIAGNOSIS_TITLE = 'Answer Diagnosis';

/** Disclosure that reveals the raw per-field metadata tabs underneath the verdict. */
export const RAW_METADATA_DISCLOSURE_LABEL = 'Raw prompt metadata';

/** The all-clear. Named so the client can assert on the exact copy the ticket specifies. */
export const HEALTHY_VERDICT_BODY =
  'Your context looks healthy. This is likely a model reasoning or prompt-phrasing issue.';

const VERDICT_HEADLINE: Record<DiagnosisStatus, string> = {
  fail: 'Something in the pipeline broke on this turn',
  warn: 'The model may not have had what it needed',
  unknown: 'Not enough was recorded to diagnose this turn',
  ok: 'Nothing in the pipeline went wrong',
};

function buildVerdict(checks: DiagnosisCheck[]): AnswerDiagnosis['verdict'] {
  const status = worstOf(checks.map(c => c.status));
  if (status === 'ok') {
    return { status, headline: VERDICT_HEADLINE.ok, body: HEALTHY_VERDICT_BODY };
  }

  const culprits = checks.filter(c => c.status === status);
  const body =
    status === 'unknown'
      ? `${culprits.map(c => c.label).join(' and ')} went unrecorded, so this turn cannot be ruled healthy or blamed on the model.`
      : `${culprits.map(c => c.label).join(' and ')} below ${culprits.length === 1 ? 'explains' : 'explain'} it. Fix that before treating this as a model-quality problem.`;

  return { status, headline: VERDICT_HEADLINE[status], body };
}

/** Folds one turn's `promptMeta` into the four-row checklist plus its verdict. */
export function diagnoseAnswer(promptMeta: PromptMeta): AnswerDiagnosis {
  const checks = [
    diagnoseRetrieval(promptMeta),
    diagnoseContext(promptMeta),
    diagnoseTools(promptMeta),
    diagnoseCorpus(promptMeta),
  ];
  return { checks, verdict: buildVerdict(checks) };
}
