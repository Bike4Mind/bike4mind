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

// Keyed off the schema's own union, not a hand-written copy of it: a new skip reason must fail to
// compile here rather than reach a reader as `undefined`.
type ForcedSkipReason = NonNullable<NonNullable<PromptMeta['retrieval']>['forcedSkipReason']>;

const FORCED_SKIP_COPY: Record<ForcedSkipReason, string> = {
  attached_files: 'files attached to this message took priority over a library search',
  personal_corpus: 'the personal corpus path took priority over a library search',
  no_lake_scope: 'this chat is set to ground on no data lake',
};

// Per-reason, because the fix differs: the first two are about what this turn carried and can be
// worked around by asking differently, the last is a standing choice on the session that cannot.
const FORCED_SKIP_REMEDY: Record<ForcedSkipReason, string> = {
  attached_files: 'Ask again without the attachment, or in a session whose knowledge base holds the material.',
  personal_corpus: 'Ask again without the attachment, or in a session whose knowledge base holds the material.',
  no_lake_scope: 'Pick the data lakes this chat should use, or clear the choice to use every one you can reach.',
};

type RetrievalSummary = NonNullable<PromptMeta['retrieval']>;

/**
 * Why the session's lake never reached any surface on this turn, when the seed recorded one. Keyed
 * on `lakeScope` (seed-written, first-writer-wins) rather than on the merged outcome, because the
 * merge ranks a tool's 'ok' above the forced arm's 'no_lakes' (see retrievalSummaryMerge.ts), so the
 * abstain is gone from `outcome` by the time a turn is stored.
 *
 * Keyed off the schema enums, like ForcedSkipReason, so a new reason fails to compile in the copy maps.
 */
type ScopeAbstainReason =
  NonNullable<RetrievalSummary['notServingLakes']>['reason'] | NonNullable<RetrievalSummary['excludedLakes']>['reason'];

/**
 * `none`: no surface searched anything (the merged outcome kept 'no_lakes'). `ownFiles`: a tool
 * still ran and found nothing - search_knowledge_base ORs the caller's own and shared files in
 * beside the lake arms (knowledgeBaseSearch/index.ts), and a draft's files are its owner's own, so
 * "not searched" would be false there and the copy says what was searched instead.
 */
type ScopeAbstainSearched = 'none' | 'ownFiles';

interface ScopeAbstain {
  reason: ScopeAbstainReason;
  searched: ScopeAbstainSearched;
}

const SCOPE_ABSTAIN_COPY: Record<ScopeAbstainReason, Record<ScopeAbstainSearched, string>> = {
  draft: {
    none: "This chat's data lake is a draft, so it was not searched - drafts do not ground answers.",
    ownFiles:
      "This chat's data lake is a draft, so it was not searched as a data lake. Your own and shared files were searched, and nothing matched.",
  },
  access: {
    none: "This chat's data lake is not one you can currently reach, so it was not searched.",
    ownFiles:
      "This chat's data lake is not one you can currently reach, so it was not searched. Your own and shared files were searched, and nothing matched.",
  },
};

const SCOPE_ABSTAIN_REMEDY: Record<ScopeAbstainReason, Record<ScopeAbstainSearched, string>> = {
  draft: {
    none: 'Publish the lake to ground answers in it.',
    ownFiles:
      'Publish the lake so retrieval searches it as a data lake. If nothing comes back after that, its files may not cover this question.',
  },
  access: {
    none: 'Check that you still have access to it, or pick a different lake for this chat.',
    ownFiles: 'Check that you still have access to it, or pick a different lake for this chat.',
  },
};

const SCOPE_ABSTAIN_CORPUS_COPY: Record<ScopeAbstainSearched, string> = {
  none: "This chat's data lake was not searched, so nothing is known about whether it is indexed.",
  ownFiles: "This chat's data lake was not searched as a data lake, so nothing is known about whether it is indexed.",
};

const countDocuments = (promptMeta: PromptMeta): number =>
  promptMeta.citables?.filter(c => c.type === 'document').length ?? 0;

const groundedThroughUninstrumentedTool = (promptMeta: PromptMeta): boolean =>
  !!promptMeta.functionCalls?.some(call => call.name === UNINSTRUMENTED_CONTENT_TOOL);

// Only an EMPTY recorded scope: a partial abstain (one named lake serving, another a draft) still
// searched something, so its volume is judged as usual. Draft wins a tie because its remedy is the
// caller's own to take.
// `notServingLakes` is the named-lake marker: the seed (ChatCompletionProcess.ts) writes it, zero
// included, only when the session named a lake. Otherwise `lakeScope`/`excludedLakes` are
// account-wide, not "this chat's lake". A failed draft lookup also leaves it absent.
function scopeAbstain(promptMeta: PromptMeta): ScopeAbstain | undefined {
  const retrieval = promptMeta.retrieval;
  if (!retrieval?.lakeScope || retrieval.lakeScope.length > 0 || !retrieval.notServingLakes) return undefined;
  let searched: ScopeAbstainSearched;
  if (retrieval.outcome === 'no_lakes') {
    searched = 'none';
  } else if (
    retrieval.outcome === 'ok' &&
    (retrieval.injected?.chunks ?? 0) === 0 &&
    // The keyword fallback's own-file hits write citables but no `injected`.
    countDocuments(promptMeta) === 0 &&
    // retrieve_knowledge_content records no volume, so a zero here cannot rule out that it read
    // something - the same guard diagnoseVolume applies.
    !groundedThroughUninstrumentedTool(promptMeta)
  ) {
    searched = 'ownFiles';
  } else {
    return undefined;
  }
  if (retrieval.notServingLakes.count > 0) return { reason: retrieval.notServingLakes.reason, searched };
  const excluded = retrieval.excludedLakes;
  if (excluded && excluded.count > 0) return { reason: excluded.reason, searched };
  return undefined;
}

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
        remedy: FORCED_SKIP_REMEDY[skip],
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

  // Ahead of the volume and no-lakes arms, behind 'failed' and 'not_indexed': those are real faults
  // on whatever did run, while a zero here is the expected result of searching no lake at all.
  const abstain = scopeAbstain(promptMeta);
  if (abstain) {
    return {
      id: 'retrieval',
      label,
      status: 'warn',
      detail: SCOPE_ABSTAIN_COPY[abstain.reason][abstain.searched],
      remedy: SCOPE_ABSTAIN_REMEDY[abstain.reason][abstain.searched],
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

function diagnoseVolume(promptMeta: PromptMeta, retrieval: RetrievalSummary): DiagnosisCheck {
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
  const attribution = attributeVolume(retrieval);

  return {
    id: 'retrieval',
    label,
    status: 'ok',
    detail: `${passages}${from} reached the model.${attribution ? ` ${attribution}` : ''}`,
  };
}

const SURFACE_LABEL: Record<string, string> = {
  'forced-retrieval': 'forced retrieval',
  'lake-memory': 'lake memory',
  knowledgeBaseSearch: 'the knowledge base search tool',
  knowledgeBaseRetrieve: 'the knowledge base retrieve tool',
};

const surfaceLabel = (surface: string): string => SURFACE_LABEL[surface] ?? surface;

const joinLabels = (labels: string[]): string =>
  labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

/**
 * `injected.chunks` sums every surface (see mergeRetrievalSummary), while the forced-retrieval
 * floors gate only their own surface - so an unattributed total reads as "the floor let these
 * through" on a turn where lake memory supplied every passage and the floor admitted none.
 *
 * Forced retrieval's own contribution is bounded above by its candidate counts (pre -> post ->
 * postSpread -> chunks, see RetrievalSummarySchema.injected), which only it writes. So an empty
 * pool is proof it injected nothing, and any other value is only an upper bound - the per-surface
 * split of `chunks` is not recorded, so a mixed turn is named as mixed rather than divided up.
 */
function attributeVolume(retrieval: NonNullable<PromptMeta['retrieval']>): string | undefined {
  // Required by the schema, but this renders stored turns that predate it without re-parsing them.
  const surfaces = retrieval.surfaces ?? [];
  const injected = retrieval.injected;
  if (!injected) return undefined;

  const forcedPool =
    injected.postSpreadFloorCandidates ?? injected.postRelativeFloorCandidates ?? injected.preRelativeFloorCandidates;
  const others = surfaces.filter(s => s !== 'forced-retrieval');
  if (surfaces.includes('forced-retrieval') && forcedPool === 0 && others.length > 0) {
    return `None came from forced retrieval, which admitted no passage past its similarity floors. Other surfaces that ran this turn: ${joinLabels(others.map(surfaceLabel))}.`;
  }

  // Worded to hold even when a listed surface injected nothing (a zero-recall lake memory, an early
  // forced exit that records no pool): `surfaces` says what ran, not what contributed.
  if (surfaces.length > 1) {
    const notOnly = surfaces.includes('forced-retrieval') ? ', not only forced retrieval' : '';
    return `That total sums every surface that ran this turn (${joinLabels(surfaces.map(surfaceLabel))})${notOnly}.`;
  }
  return undefined;
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

  // "Searchable" would be a claim about a lake no surface ever compared against.
  const abstain = scopeAbstain(promptMeta);
  if (abstain) {
    return {
      id: 'corpus',
      label,
      status: 'unknown',
      detail: SCOPE_ABSTAIN_CORPUS_COPY[abstain.searched],
    };
  }

  if (outcome === 'no_lakes') {
    return {
      id: 'corpus',
      label,
      status: 'unknown',
      detail: 'No knowledge base was in scope, so nothing is known about whether one is indexed.',
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

type FunctionCall = NonNullable<PromptMeta['functionCalls']>[number];

// The llm-adapters backend tool loops store a thrown tool error as the call's returnValue, either
// prefixed `Error processing <name> tool: ` (Bedrock, Anthropic, OpenAI, DeepSeek, Kimi, xAI) or
// `Error running <name>: ` (ollamaBackend.ts), or as JSON `{"error": "<msg>"}` (geminiBackend.ts).
const TOOL_ERROR_PREFIX = /^Error (?:processing \S+ tool|running \S+): /;
const TIMED_OUT = /\btimed out\b/i;
const MAX_TIMEOUT_MESSAGE_CHARS = 160;

function unwrapJsonError(text: string): string {
  if (!text.startsWith('{')) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      // Any other JSON shape yields no message, so raw JSON never reaches the copy.
      const { error } = parsed as { error?: unknown };
      return typeof error === 'string' ? error : '';
    }
  } catch {
    // Not JSON; use the text as-is.
  }
  return text;
}

function capMessage(text: string): string {
  if (text.length <= MAX_TIMEOUT_MESSAGE_CHARS) return text;
  // Drop a cut-off separator or period so the ellipsis never renders as `....` or `; ...`.
  return `${text.slice(0, MAX_TIMEOUT_MESSAGE_CHARS - 3).replace(/[\s.;,:]+$/, '')}...`;
}

/**
 * The failure text of a call that failed by timing out, else undefined. Only failed calls qualify,
 * so a successful call whose content mentions a timeout never matches; a redacted call (no text)
 * falls back to the generic copy.
 */
function timeoutMessage(call: FunctionCall): string | undefined {
  if (call.success !== false && !call.error) return undefined;
  const text = unwrapJsonError(call.error || call.returnValue || '')
    .replace(TOOL_ERROR_PREFIX, '')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  return TIMED_OUT.test(text) ? text : undefined;
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
    const allFailed = failed.length === calls.length;
    const explicitlySucceeded = calls.filter(call => call.success === true).length;
    const otherCount = calls.length - failed.length - explicitlySucceeded;
    const successPhrase =
      explicitlySucceeded > 0
        ? `${explicitlySucceeded} succeeded${otherCount > 0 ? ` and ${otherCount} had no recorded verdict` : ''}`
        : `${otherCount} had no recorded verdict`;
    const timeouts = failed.map(timeoutMessage);
    if (timeouts.every((m): m is string => !!m)) {
      // Each message already says "timed out", so the lead-in says "failed" rather than repeat it.
      const messages = capMessage([...new Set(timeouts)].join('; '));
      const sentence = messages.endsWith('...') ? messages : `${messages}.`;
      return {
        id: 'tools',
        label,
        status: allFailed ? 'fail' : 'warn',
        detail: allFailed
          ? `${failed.length === 1 ? 'The only tool call' : `All ${failed.length} tool calls`} failed${named}: ${sentence}`
          : `${failed.length} of ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'} failed${named}: ${sentence} ${successPhrase[0].toUpperCase()}${successPhrase.slice(1)} and the model replied with what it got.`,
        remedy: allFailed
          ? 'The service behind the tool did not respond in time; this is usually transient, so retry the question.'
          : 'Retry if the answer seems incomplete; a timeout is usually transient.',
      };
    }
    return {
      id: 'tools',
      label,
      status: allFailed ? 'fail' : 'warn',
      detail: allFailed
        ? `${failed.length === 1 ? 'The only tool call' : `All ${failed.length} tool calls`} failed${named}.`
        : `${failed.length} of ${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'} failed${named}, but ${successPhrase} and the model replied with what it got.`,
      remedy: allFailed
        ? 'Retry the question; the answer was built with none of what those tools would have returned.'
        : 'Retry if the answer seems incomplete; otherwise the successful calls may have been enough.',
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
