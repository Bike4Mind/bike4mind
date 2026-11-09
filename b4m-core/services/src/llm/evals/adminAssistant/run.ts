/**
 * Asks every admin eval row on a live deployment the way the admin page does, and grades each reply:
 * a fresh `admin-assistant` session, then `POST /api/ai/llm` with the `/admin` view context, then a poll
 * of the quest. The turn itself (gate, prompt, view registry, tools) runs server-side, unmodified.
 * Fetch-injected and fs-free, like the lakeRag driver it reuses for HTTP.
 */
import { ADMIN_ASSISTANT_SURFACE } from '@bike4mind/common';
import { call, LakeRagHttpError, pollUntil, type Json } from '../lakeRag/http';
import type { LakeRagApi } from '../lakeRag/provision';
import type { AdminEvalCase, AdminEvalCategory } from './cases';
import { fillTarget, gradeAdminCase, gradeAdminEmpty, type AdminEvalGrade, type AdminFunctionCall } from './grade';

const TERMINAL_QUEST_STATUSES: ReadonlySet<string> = new Set(['done', 'stopped']);

/**
 * The minimal /admin view context: enough to trigger the server's view-registry nudge
 * (viewRegistryPrompt.ts). The real page also sends its tab and a brief; this does not.
 */
const ADMIN_VIEW_CONTEXT = {
  role: 'system',
  content: '[Current View Context] User is on the Admin dashboard. Path: /admin',
  perTurn: true,
} as const;

export type AdminEvalTurn = {
  rowId: string;
  category: AdminEvalCategory;
  sample: number;
  grade: AdminEvalGrade;
  /** Tool names called, in order, for diagnosis. */
  toolsCalled: string[];
  questId?: string;
};

export type AdminEvalRunOptions = {
  model: string;
  /** Turns per row. Default 1. */
  samples?: number;
  /** The seeded user's email, for rows that name `{target}`. */
  target?: string;
  /** Longest a turn may wait on its quest, in ms. Default 2 minutes. A stall costs one turn, not the run. */
  turnTimeoutMs?: number;
  /** Called as each turn finishes, so a caller can keep partial results. */
  onTurn?: (turn: AdminEvalTurn) => void;
};

export const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 1000;

/** A 401 that survives a token renewal aborts the whole run: every later turn would fail too. */
export class AdminEvalUnauthorizedError extends Error {
  constructor(cause: LakeRagHttpError) {
    super(`admin eval aborted: the credential was rejected (401). Mint a fresh one and rerun. ${cause.message}`);
    this.name = 'AdminEvalUnauthorizedError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function idOf(json: Json, what: string): string {
  const id = json.id ?? json._id;
  if (typeof id !== 'string' || !id) throw new Error(`${what}: response has no id`);
  return id;
}

async function askOnce(api: LakeRagApi, rowId: string, question: string, model: string, turnTimeoutMs: number) {
  const session = await call(api, 'POST', '/api/sessions/create', {
    name: `admin-eval-${rowId}`,
    surface: ADMIN_ASSISTANT_SURFACE,
  });
  // The endpoint queues the turn and answers with the quest; the reply arrives through the poll.
  const ack = await call(api, 'POST', '/api/ai/llm', {
    sessionId: idOf(session, 'create session'),
    message: question,
    historyCount: 10,
    fabFileIds: [],
    params: { model },
    extraContextMessages: [ADMIN_VIEW_CONTEXT],
  });
  const questId = idOf(isRecord(ack.quest) ? ack.quest : {}, 'llm');
  let quest: Json = {};
  await pollUntil({ ...api, pollTimeoutMs: turnTimeoutMs }, `quest ${questId}`, async () => {
    quest = await call(api, 'GET', `/api/v1/quests/${encodeURIComponent(questId)}`);
    const status = typeof quest.status === 'string' ? quest.status : 'unknown';
    return TERMINAL_QUEST_STATUSES.has(status) ? { done: true } : { done: false, status };
  });
  return { questId, quest };
}

function functionCallsOf(quest: Json): AdminFunctionCall[] {
  const calls = isRecord(quest.promptMeta) ? quest.promptMeta.functionCalls : undefined;
  return Array.isArray(calls) ? calls.filter(isRecord) : [];
}

/**
 * Runs every row sequentially. A failed turn is recorded as a failed grade and the run continues;
 * only a 401 aborts.
 */
export async function runAdminEval(
  api: LakeRagApi,
  rows: readonly AdminEvalCase[],
  opts: AdminEvalRunOptions
): Promise<AdminEvalTurn[]> {
  const samples = opts.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`samples must be a positive integer, got ${samples}`);
  if (!opts.target && rows.some(r => r.needsTarget)) throw new Error('rows need a target user but none was given');

  const turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const turns: AdminEvalTurn[] = [];
  const record = (turn: AdminEvalTurn) => {
    turns.push(turn);
    opts.onTurn?.(turn);
  };
  for (const row of rows) {
    for (let sample = 0; sample < samples; sample++) {
      const base = { rowId: row.id, category: row.category, sample };
      let turn: AdminEvalTurn;
      try {
        const { questId, quest } = await askOnce(
          api,
          row.id,
          fillTarget(row.question, opts.target ?? ''),
          opts.model,
          turnTimeoutMs
        );
        const reply = typeof quest.reply === 'string' ? quest.reply : '';
        const calls = functionCallsOf(quest);
        const toolsCalled = calls.map(c => String(c.name));
        const grade =
          quest.type === 'error'
            ? gradeAdminEmpty(`quest error: ${reply.slice(0, 200)}`)
            : !reply.trim() && calls.length === 0
              ? gradeAdminEmpty('empty reply')
              : gradeAdminCase(row, { reply, functionCalls: calls });
        turn = { ...base, questId, grade, toolsCalled };
      } catch (error) {
        if (error instanceof LakeRagHttpError && error.status === 401) throw new AdminEvalUnauthorizedError(error);
        const reason = error instanceof Error ? error.message : String(error);
        turn = { ...base, grade: gradeAdminEmpty(`turn failed: ${reason}`), toolsCalled: [] };
      }
      record(turn);
    }
  }
  return turns;
}
