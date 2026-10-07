import rawBank from './bank.json';

export type LakeRagCaseKind = 'fact' | 'stale-same-name' | 'stale-different-name' | 'absent';
export type LakeRagExpectation = { type: 'token' | 'pattern'; value: string };

export interface LakeRagBankRow {
  id: string;
  subject: string;
  kind: LakeRagCaseKind;
  question: string;
  expect: LakeRagExpectation[];
  expectSource: string | null;
  rejectTokens: string[];
}

export type LakeRagCitable =
  | string
  | {
      fileName?: string;
      filename?: string;
      name?: string;
      path?: string;
      source?: string;
      title?: string;
    };

export interface LakeRagPromptMeta {
  citationStyle?: 'indexed';
  citables?: LakeRagCitable[];
}

export interface LakeRagGradeResult {
  passed: boolean;
  answerMatched: boolean;
  staleValueRejected: boolean;
  citationMatched: boolean;
  matchedExpectations: string[];
  rejectedTokensFound: string[];
  citedSources: string[];
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sourceBasename(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.toLowerCase() ?? value.toLowerCase();
}

function citableSource(citable: LakeRagCitable): string {
  if (typeof citable === 'string') return citable;
  return citable.fileName ?? citable.filename ?? citable.source ?? citable.path ?? citable.name ?? citable.title ?? '';
}

function expectationMatches(expectation: LakeRagExpectation, answer: string): boolean {
  if (expectation.type === 'token') return normalizeText(answer).includes(normalizeText(expectation.value));
  return new RegExp(expectation.value, 'i').test(answer);
}

function validateExpectation(value: unknown, rowId: string): LakeRagExpectation {
  if (!isRecord(value) || (value.type !== 'token' && value.type !== 'pattern') || typeof value.value !== 'string') {
    throw new Error(`Invalid lakeRag expectation in ${rowId}`);
  }
  if (value.type === 'pattern') new RegExp(value.value);
  return { type: value.type, value: value.value };
}

function validateRow(value: unknown): LakeRagBankRow {
  if (!isRecord(value) || typeof value.id !== 'string') throw new Error('Invalid lakeRag bank row');
  const id = value.id;
  if (typeof value.subject !== 'string') throw new Error(`Invalid lakeRag subject in ${id}`);
  if (
    value.kind !== 'fact' &&
    value.kind !== 'stale-same-name' &&
    value.kind !== 'stale-different-name' &&
    value.kind !== 'absent'
  ) {
    throw new Error(`Invalid lakeRag kind in ${id}`);
  }
  if (typeof value.question !== 'string') throw new Error(`Invalid lakeRag question in ${id}`);
  if (!Array.isArray(value.expect) || value.expect.length === 0) throw new Error(`Invalid lakeRag expect in ${id}`);
  if (typeof value.expectSource !== 'string' && value.expectSource !== null) {
    throw new Error(`Invalid lakeRag expectSource in ${id}`);
  }
  if (!Array.isArray(value.rejectTokens) || !value.rejectTokens.every(token => typeof token === 'string')) {
    throw new Error(`Invalid lakeRag rejectTokens in ${id}`);
  }
  return {
    id,
    subject: value.subject,
    kind: value.kind,
    question: value.question,
    expect: value.expect.map(expectation => validateExpectation(expectation, id)),
    expectSource: value.expectSource,
    rejectTokens: value.rejectTokens,
  };
}

const BANK = Object.freeze((rawBank as unknown[]).map(validateRow));

export function loadLakeRagBank(subject?: string): LakeRagBankRow[] {
  const rows = subject ? BANK.filter(row => row.subject === subject) : BANK;
  return rows.map(row => ({
    ...row,
    expect: row.expect.map(expectation => ({ ...expectation })),
    rejectTokens: [...row.rejectTokens],
  }));
}

export function gradeLakeRagAnswer(
  row: LakeRagBankRow,
  answer: string,
  promptMeta: LakeRagPromptMeta = {}
): LakeRagGradeResult {
  const matchedExpectations = row.expect
    .filter(expectation => expectationMatches(expectation, answer))
    .map(e => e.value);
  const rejectedTokensFound = row.rejectTokens.filter(token => normalizeText(answer).includes(normalizeText(token)));
  const citedSources = resolveIndexedCitations(answer, promptMeta);
  const citationMatched =
    row.expectSource === null ||
    citedSources.some(source => sourceBasename(source) === sourceBasename(row.expectSource ?? ''));
  const answerMatched = matchedExpectations.length === row.expect.length;
  const staleValueRejected = rejectedTokensFound.length === 0;

  const reasons: string[] = [];
  if (!answerMatched) reasons.push('missing expected answer token or pattern');
  if (!staleValueRejected) reasons.push(`included stale value: ${rejectedTokensFound.join(', ')}`);
  if (!citationMatched) reasons.push(`missing citation for ${row.expectSource}`);

  return {
    passed: answerMatched && staleValueRejected && citationMatched,
    answerMatched,
    staleValueRejected,
    citationMatched,
    matchedExpectations,
    rejectedTokensFound,
    citedSources,
    reasons,
  };
}

function resolveIndexedCitations(answer: string, promptMeta: LakeRagPromptMeta): string[] {
  if (promptMeta.citationStyle !== 'indexed') return [];
  const citables = promptMeta.citables ?? [];
  return [...answer.matchAll(/\[(\d+)]/g)]
    .map(match => Number(match[1]))
    .filter(index => Number.isInteger(index) && index > 0 && index <= citables.length)
    .map(index => citableSource(citables[index - 1]))
    .filter(source => source.length > 0);
}
