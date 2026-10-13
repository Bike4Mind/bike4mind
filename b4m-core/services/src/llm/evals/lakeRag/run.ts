/**
 * Asks every bank question on a live deployment under three arms and grades each reply:
 * - `lake`: a session bound to the subject's lake (`dataLakeId`), indexed citations;
 * - `multi-lake`: the same, plus `retrievalTags` naming the other subjects' lakes as distractors;
 * - `plain`: no lake and `promptMode: 'raw'`, the bare-model baseline.
 *
 * One fresh session per question, so an earlier answer cannot leak through history. Fetch-injected
 * and fs-free, like provision.ts.
 */
import { gradeLakeRag, gradeLakeRagEmpty, type LakeRagGrade } from './grade';
import type { LakeRagBankRow, LakeRagKind } from './bank';
import { call, LakeRagHttpError, pollUntil, type Json } from './http';
import type { LakeRagApi, ProvisionedLake } from './provision';

export const LAKE_RAG_ARMS = ['lake', 'multi-lake', 'plain'] as const;
export type LakeRagArm = (typeof LAKE_RAG_ARMS)[number];

const SEARCH_TOOLS: ReadonlySet<string> = new Set(['search_knowledge_base', 'retrieve_knowledge_content']);
const TERMINAL_QUEST_STATUSES: ReadonlySet<string> = new Set(['done', 'stopped']);

export type RetrievalDetection = {
  ran: boolean;
  via: 'citables' | 'tool' | 'none';
  /** `promptMeta.retrieval`, recorded for diagnosis only; it does not decide `ran`. */
  summary?: { attempted: boolean; outcome?: string };
};

/** The subset of a polled quest's `promptMeta` this driver reads. Every field is untrusted JSON. */
export type LakeRagPromptMeta = { citables?: unknown; functionCalls?: unknown; retrieval?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Retrieval ran when the turn has a document citable or called a knowledge-base search tool. */
export function detectRetrieval(promptMeta?: LakeRagPromptMeta | null): RetrievalDetection {
  const citables = Array.isArray(promptMeta?.citables) ? promptMeta.citables : [];
  const calls = Array.isArray(promptMeta?.functionCalls) ? promptMeta.functionCalls : [];
  const retrieval = promptMeta?.retrieval;
  const summary =
    isRecord(retrieval) && typeof retrieval.attempted === 'boolean'
      ? {
          attempted: retrieval.attempted,
          ...(typeof retrieval.outcome === 'string' && { outcome: retrieval.outcome }),
        }
      : undefined;
  const via = citables.some(c => isRecord(c) && c.type === 'document')
    ? 'citables'
    : calls.some(c => isRecord(c) && typeof c.name === 'string' && SEARCH_TOOLS.has(c.name))
      ? 'tool'
      : 'none';
  return { ran: via !== 'none', via, ...(summary && { summary }) };
}

export type LakeRagTurn = {
  arm: LakeRagArm;
  rowId: string;
  kind: LakeRagKind;
  sample: number;
  grade: LakeRagGrade;
  retrieval: RetrievalDetection;
  questId?: string;
};

export type LakeRagRunOptions = {
  model: string;
  /** Turns per question per arm. Default 1. */
  samples?: number;
  arms?: readonly LakeRagArm[];
};

/** A 401 that survives a token renewal aborts the whole run: every later turn would fail too. */
export class LakeRagUnauthorizedError extends Error {
  constructor(cause: LakeRagHttpError) {
    super(`lake RAG eval aborted: the credential was rejected (401). Mint a fresh one and rerun. ${cause.message}`);
    this.name = 'LakeRagUnauthorizedError';
  }
}

/** The `POST /api/v1/sessions` body for one arm. */
export function lakeRagSessionBody(
  arm: LakeRagArm,
  row: Pick<LakeRagBankRow, 'id' | 'subject'>,
  lakes: Record<string, ProvisionedLake>
): Json {
  const name = `lakerag-eval-${arm}-${row.id}`;
  if (arm === 'plain') return { name };
  const own = lakes[row.subject];
  const body: Json = { name, dataLakeId: own.id, citationStyle: 'indexed' };
  // The body's retrievalTags replace the lake's defaults rather than merging with them
  // (apps/client/pages/api/v1/sessions/index.ts), so the own tag must be listed explicitly.
  if (arm === 'multi-lake') {
    const distractors = Object.entries(lakes)
      .filter(([subject]) => subject !== row.subject)
      .map(([, lake]) => lake.datalakeTag);
    body.retrievalTags = [own.datalakeTag, ...distractors];
  }
  return body;
}

function idOf(json: Json, what: string): string {
  const id = json.id ?? json._id;
  if (typeof id !== 'string' || !id) throw new Error(`${what}: response has no id`);
  return id;
}

async function askOnce(
  api: LakeRagApi,
  arm: LakeRagArm,
  row: LakeRagBankRow,
  lakes: Record<string, ProvisionedLake>,
  model: string
): Promise<{ questId: string; quest: Json }> {
  const session = await call(api, 'POST', '/api/v1/sessions', lakeRagSessionBody(arm, row, lakes));
  // wait:false returns the quest id at once; wait:true runs the turn inline, and a gateway timeout
  // there would lose the id.
  const ack = await call(api, 'POST', '/api/chat', {
    sessionId: idOf(session, 'create session'),
    message: row.question,
    model,
    wait: false,
    ...(arm === 'plain' && { promptMode: 'raw' }),
  });
  const questId = idOf(ack, 'chat');
  let quest: Json = {};
  // Citables come only from this owner read: the chat ack carries no promptMeta.
  await pollUntil(api, `quest ${questId}`, async () => {
    quest = await call(api, 'GET', `/api/v1/quests/${encodeURIComponent(questId)}`);
    const status = typeof quest.status === 'string' ? quest.status : 'unknown';
    return TERMINAL_QUEST_STATUSES.has(status) ? { done: true } : { done: false, status };
  });
  return { questId, quest };
}

function gradeQuest(arm: LakeRagArm, row: LakeRagBankRow, quest: Json): LakeRagGrade {
  const reply = typeof quest.reply === 'string' ? quest.reply : '';
  if (quest.type === 'error') return gradeLakeRagEmpty(row, `quest error: ${reply.slice(0, 200)}`);
  if (!reply.trim()) return gradeLakeRagEmpty(row, 'empty reply');
  if (arm === 'plain') {
    // No lake to cite, so the bare model is scored on the answer and stale rejection only.
    const grade = gradeLakeRag(row, reply, { citationStyle: 'named' });
    return { ...grade, passed: grade.answer && grade.staleRejected };
  }
  const meta = isRecord(quest.promptMeta) ? quest.promptMeta : {};
  const citables = Array.isArray(meta.citables)
    ? meta.citables.map(c => ({ title: isRecord(c) && typeof c.title === 'string' ? c.title : '' }))
    : [];
  return gradeLakeRag(row, reply, { citationStyle: 'indexed', citables });
}

/**
 * Runs every row under every requested arm, sequentially. A failed turn is recorded as an empty
 * grade and the run continues; only a 401 aborts.
 */
export async function runLakeRagArms(
  api: LakeRagApi,
  rows: readonly LakeRagBankRow[],
  lakes: Record<string, ProvisionedLake>,
  opts: LakeRagRunOptions
): Promise<LakeRagTurn[]> {
  const arms = opts.arms ?? LAKE_RAG_ARMS;
  const samples = opts.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`samples must be a positive integer, got ${samples}`);
  const missing = [...new Set(rows.map(row => row.subject))].filter(subject => !lakes[subject]);
  if (arms.some(arm => arm !== 'plain') && missing.length > 0) {
    throw new Error(`no provisioned lake for subject(s): ${missing.join(', ')}`);
  }

  const turns: LakeRagTurn[] = [];
  for (const arm of arms) {
    for (const row of rows) {
      for (let sample = 0; sample < samples; sample++) {
        const base = { arm, rowId: row.id, kind: row.kind, sample };
        try {
          const { questId, quest } = await askOnce(api, arm, row, lakes, opts.model);
          const promptMeta = isRecord(quest.promptMeta) ? quest.promptMeta : undefined;
          turns.push({ ...base, questId, grade: gradeQuest(arm, row, quest), retrieval: detectRetrieval(promptMeta) });
        } catch (error) {
          if (error instanceof LakeRagHttpError && error.status === 401) throw new LakeRagUnauthorizedError(error);
          const reason = error instanceof Error ? error.message : String(error);
          turns.push({
            ...base,
            grade: gradeLakeRagEmpty(row, `turn failed: ${reason}`),
            retrieval: detectRetrieval(),
          });
        }
      }
    }
  }
  return turns;
}
