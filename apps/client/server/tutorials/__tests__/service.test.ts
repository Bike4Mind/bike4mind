// Copyright (c) Bike4Mind, Inc. All rights reserved. SPDX-License-Identifier: LicenseRef-Bike4Mind-Proprietary
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import type { ITutorialModuleProgress } from '../models';
import type { TutorialModule } from '../types';
import {
  advanceModule,
  answerTurn,
  moduleSheet,
  enabledModules,
  readProgress,
  recordPosition,
  resumeModule,
  sessionIsScripted,
  startModule,
  TURN_INSERT_GRACE_MS,
  TUTORIAL_MARKER_TYPE,
  TUTORIAL_OFF_REPLY,
  TUTORIAL_UPDATED_REPLY,
  type TutorialDeps,
  type TutorialQuest,
} from '../service';

const MODULE: TutorialModule = {
  id: 'demo',
  title: 'Demo',
  pitch: 'p',
  openingPrompt: 'open',
  sheet: { name: 'demo.csv', csv: 'a,b\n' },
  version: 1,
  revision: 0,
  enabled: true,
  steps: [
    { id: 'attach-sheet', type: 'prompt', body: '', turn: 1 },
    { id: 'finish', type: 'point', body: '' },
  ],
  transcript: [
    { prompt: 'open', reply: 'hello' },
    { prompt: 'second', reply: 'two', attachSheet: true },
    { prompt: 'third', reply: 'three', uiSideEffects: [{ type: 'applyChange', payload: { x: 1 } }] },
  ],
};

function makeDeps(opts: { owned?: Set<string>; clock?: () => Date } = {}) {
  const progress = new Map<string, Record<string, ITutorialModuleProgress>>();
  const quests: TutorialQuest[] = [];
  const canvasRows: Parameters<NonNullable<TutorialDeps['canvas']>['seed']>[0][] = [];
  const sessions: { id: string; knowledgeIds: string[] }[] = [];
  const sheets: string[] = [];
  const sheetOptions: unknown[] = [];
  const deleted: string[] = [];
  const warnings: string[] = [];
  let now = new Date('2026-10-28T12:00:00Z');
  const owned = opts.owned ?? new Set<string>();
  const deps: TutorialDeps = {
    modules: [MODULE, { ...MODULE, id: 'off', enabled: false }],
    progress: {
      read: async (u, m) => {
        const e = progress.get(u)?.[m];
        return e ? { ...e } : e;
      },
      all: async u => ({ ...(progress.get(u) ?? {}) }),
      begin: async (u, m, e) => {
        progress.set(u, { ...(progress.get(u) ?? {}), [m]: e });
      },
      claimTurn: async (u, m, s, from, to, at) => {
        const e = progress.get(u)?.[m];
        if (!e || e.sessionId !== s || e.turn !== from) return false;
        e.turn = to;
        e.turnClaimedAt = at;
        return true;
      },
      reclaimTurn: async (u, m, s, turn, expected, at) => {
        const e = progress.get(u)?.[m];
        if (!e || e.sessionId !== s || e.turn !== turn || e.turnClaimedAt.getTime() !== expected.getTime()) {
          return false;
        }
        e.turnClaimedAt = at;
        return true;
      },
      setPosition: async (u, m, stepId, status) => {
        const e = progress.get(u)?.[m];
        if (!e) return false;
        e.stepId = stepId;
        e.status = status;
        return true;
      },
    },
    quests: {
      create: async q => {
        const saved = { ...q, id: `q${quests.length + 1}` };
        quests.push(saved);
        return saved;
      },
      findAllBySessionId: async s => quests.filter(q => q.sessionId === s),
    },
    canvas: {
      seed: async row => {
        if (!canvasRows.some(r => r.sessionId === row.sessionId && r.questId === row.questId)) canvasRows.push(row);
      },
    },
    ensureSheet: async (_userId, _module, options) => {
      sheets.push('sheet-1');
      sheetOptions.push(options);
      return 'sheet-1';
    },
    createSession: async () => {
      const id = `aaaaaaaaaaaaaaaaaaaa${String(sessions.length).padStart(4, '0')}`;
      sessions.push({ id, knowledgeIds: [] });
      owned.add(id);
      return { id };
    },
    ownsSession: async (s, u) => owned.has(s) && u === 'u1',
    deleteSession: async s => {
      deleted.push(s);
      return true;
    },
    warn: message => {
      warnings.push(message);
    },
    now: () => (opts.clock ? opts.clock() : now),
  };
  return {
    deps,
    quests,
    canvasRows,
    sessions,
    sheets,
    sheetOptions,
    progress,
    deleted,
    warnings,
    advanceClock: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('startModule', () => {
  it('opens an empty session, files the sheet for the user, and waits for the opening message', async () => {
    const { deps, quests, sessions, sheets, sheetOptions, progress } = makeDeps();
    const r = await startModule(deps, 'u1', 'demo');
    expect(r).toEqual({ ok: true, sessionId: sessions[0].id, turn: -1, version: 1, revision: 0 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].knowledgeIds).toEqual([]);
    expect(sheets).toEqual(['sheet-1']);
    // A fresh run lifts its copy to the top of Recent, so the attach step rings the first one listed.
    expect(sheetOptions).toEqual([{ toTop: true }]);
    expect(quests).toHaveLength(0);
    expect(progress.get('u1')!.demo).toMatchObject({
      status: 'in_progress',
      turn: -1,
      moduleVersion: 1,
      moduleRevision: 0,
    });
  });

  it('restart creates a fresh session and points progress at it', async () => {
    const { deps, sessions, progress } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    await startModule(deps, 'u1', 'demo');
    expect(sessions).toHaveLength(2);
    expect(progress.get('u1')!.demo.sessionId).toBe(sessions[1].id);
  });

  it('restart deletes a previous session that holds only recorded turns', async () => {
    const { deps, sessions, deleted } = makeDeps();
    const first = await startModule(deps, 'u1', 'demo');
    if (!first.ok) throw new Error('start failed');
    await advanceModule(deps, 'u1', { moduleId: 'demo', sessionId: first.sessionId, turn: 0 });
    await advanceModule(deps, 'u1', { moduleId: 'demo', sessionId: first.sessionId, turn: 1 });
    await startModule(deps, 'u1', 'demo');
    expect(deleted).toEqual([sessions[0].id]);
  });

  it('restart keeps a previous session the user wrote in', async () => {
    const { deps, quests, sessions, deleted } = makeDeps();
    const first = await startModule(deps, 'u1', 'demo');
    if (!first.ok) throw new Error('start failed');
    await advanceModule(deps, 'u1', { moduleId: 'demo', sessionId: first.sessionId, turn: 0 });
    quests.push({ ...quests[0], id: 'mine', prompt: 'what is this?', uiSideEffects: [] });
    const second = await startModule(deps, 'u1', 'demo');
    expect(second).toMatchObject({ ok: true, sessionId: sessions[1].id });
    expect(deleted).toEqual([]);
  });

  it('restart keeps a previous session the user left', async () => {
    const { deps, progress, deleted } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    progress.get('u1')!.demo.status = 'left';
    await startModule(deps, 'u1', 'demo');
    expect(deleted).toEqual([]);
  });

  it('restart keeps a previous session the user finished', async () => {
    const { deps, progress, deleted } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    progress.get('u1')!.demo.status = 'finished';
    await startModule(deps, 'u1', 'demo');
    expect(deleted).toEqual([]);
  });

  it('restart keeps a previous session the user no longer owns', async () => {
    const { deps, sessions, deleted } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    const owns = deps.ownsSession;
    deps.ownsSession = async (s, u) => s !== sessions[0].id && owns(s, u);
    await startModule(deps, 'u1', 'demo');
    expect(deleted).toEqual([]);
  });

  it('restart still succeeds when deleting the previous session fails', async () => {
    const { deps, sessions, progress, warnings } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    deps.deleteSession = async () => {
      throw new Error('mongo down');
    };
    const r = await startModule(deps, 'u1', 'demo');
    expect(r).toEqual({ ok: true, sessionId: sessions[1].id, turn: -1, version: 1, revision: 0 });
    expect(progress.get('u1')!.demo.sessionId).toBe(sessions[1].id);
    expect(warnings).toEqual([expect.stringContaining('mongo down')]);
  });

  it('answers 404 for an unknown or disabled module', async () => {
    const { deps } = makeDeps();
    expect(await startModule(deps, 'u1', 'nope')).toMatchObject({ ok: false, status: 404 });
    expect(await startModule(deps, 'u1', 'off')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('resumeModule', () => {
  const leftAt = async (stepId = 'finish') => {
    const ctx = makeDeps();
    const first = await startModule(ctx.deps, 'u1', 'demo');
    if (!first.ok) throw new Error('start failed');
    await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId: first.sessionId, turn: 0 });
    await recordPosition(ctx.deps, 'u1', { moduleId: 'demo', stepId, status: 'left' });
    return { ...ctx, sessionId: first.sessionId };
  };

  it('reopens a left module in its own session, running again on the step it stopped at', async () => {
    const { deps, sessions, progress, sessionId } = await leftAt();
    expect(await resumeModule(deps, 'u1', 'demo')).toEqual({ ok: true, sessionId, version: 1, revision: 0 });
    expect(sessions).toHaveLength(1);
    expect(progress.get('u1')!.demo).toMatchObject({ status: 'in_progress', stepId: 'finish', sessionId });
  });

  it('reopens a running module in its session', async () => {
    const { deps, sessions } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    expect(await resumeModule(deps, 'u1', 'demo')).toEqual({
      ok: true,
      sessionId: sessions[0].id,
      version: 1,
      revision: 0,
    });
  });

  it('refuses when the session is gone, so the caller starts fresh', async () => {
    const { deps, sessionId } = await leftAt();
    deps.ownsSession = async s => s !== sessionId;
    expect(await resumeModule(deps, 'u1', 'demo')).toMatchObject({ ok: false, status: 404, code: 'SESSION_GONE' });
  });

  it('refuses a left session the user wrote in', async () => {
    const { deps, quests, progress } = await leftAt();
    quests.push({ ...quests[0], id: 'mine', prompt: 'what is this?', uiSideEffects: [] });
    expect(await resumeModule(deps, 'u1', 'demo')).toMatchObject({ ok: false, code: 'SESSION_TOUCHED' });
    expect(progress.get('u1')!.demo.status).toBe('left');
  });

  it('refuses a module left at the bridge or before any step, which the panel treats as done', async () => {
    for (const stepId of ['bridge', '']) {
      const { deps, progress } = await leftAt();
      progress.get('u1')!.demo.stepId = stepId;
      expect(await resumeModule(deps, 'u1', 'demo')).toMatchObject({ ok: false, status: 409, code: 'FINISHED' });
      expect(progress.get('u1')!.demo.status).toBe('left');
    }
  });

  it('refuses a finished, updated, unstarted or unknown module', async () => {
    const finished = await leftAt();
    finished.progress.get('u1')!.demo.status = 'finished';
    expect(await resumeModule(finished.deps, 'u1', 'demo')).toMatchObject({ ok: false, code: 'FINISHED' });

    const updated = await leftAt();
    updated.progress.get('u1')!.demo.moduleVersion = 0;
    expect(await resumeModule(updated.deps, 'u1', 'demo')).toMatchObject({ ok: false, code: 'VERSION_CHANGED' });

    const revised = await leftAt();
    revised.progress.get('u1')!.demo.moduleRevision = 3;
    expect(await resumeModule(revised.deps, 'u1', 'demo')).toMatchObject({ ok: false, code: 'VERSION_CHANGED' });

    // A walk begun before revisions existed carries none, which reads as revision 0.
    const legacy = await leftAt();
    delete legacy.progress.get('u1')!.demo.moduleRevision;
    expect(await resumeModule(legacy.deps, 'u1', 'demo')).not.toMatchObject({ code: 'VERSION_CHANGED' });

    const { deps } = makeDeps();
    expect(await resumeModule(deps, 'u1', 'demo')).toMatchObject({ ok: false, status: 404 });
    expect(await resumeModule(deps, 'u1', 'off')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('moduleSheet', () => {
  it("names the module's sheet in the user's files, and 404s an unknown or disabled module", async () => {
    const { deps } = makeDeps();
    expect(await moduleSheet(deps, 'u1', 'demo')).toEqual({ ok: true, fileId: 'sheet-1' });
    expect(await moduleSheet(deps, 'u1', 'off')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('advanceModule', () => {
  let ctx: ReturnType<typeof makeDeps>;
  let sessionId: string;
  beforeEach(async () => {
    ctx = makeDeps();
    const started = await startModule(ctx.deps, 'u1', 'demo');
    if (!started.ok) throw new Error('start failed');
    sessionId = started.sessionId;
    await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 0 });
  });

  it('inserts the recorded quest from the transcript, never the request', async () => {
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: true, turn: 1 });
    const q = ctx.quests[1];
    expect(q).toMatchObject({ prompt: 'second', reply: 'two', status: 'done', fabFileIds: ['sheet-1'] });
    expect(q.uiSideEffects).toContainEqual({ type: TUTORIAL_MARKER_TYPE, payload: { moduleId: 'demo', turn: 1 } });
    expect(ctx.progress.get('u1')!.demo.turn).toBe(1);
  });

  it('carries the transcript side effects on the turn that has them', async () => {
    await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 2 });
    expect(ctx.quests[2].uiSideEffects[0]).toEqual({ type: 'applyChange', payload: { x: 1 } });
    expect(ctx.quests[2].fabFileIds).toBeUndefined();
  });

  it('refuses to advance a left or finished walk and appends nothing', async () => {
    for (const [status, code] of [
      ['left', 'NOT_RUNNING'],
      ['finished', 'FINISHED'],
    ] as const) {
      ctx.progress.get('u1')!.demo.status = status;
      const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
      expect(r).toMatchObject({ ok: false, status: 409, code });
      expect(ctx.quests).toHaveLength(1);
    }
  });

  it('rejects a session the progress row does not name', async () => {
    ctx.deps.ownsSession = async () => true;
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId: 'b'.repeat(24), turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(ctx.quests).toHaveLength(1);
  });

  it('rejects a session the user does not own, even when progress names it', async () => {
    ctx.deps.ownsSession = async () => false;
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects another user's attempt on the session", async () => {
    const r = await advanceModule(ctx.deps, 'u2', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(ctx.quests).toHaveLength(1);
  });

  it('rejects a turn out of range', async () => {
    for (const turn of [3, -1, 1.5]) {
      const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn });
      expect(r, `turn ${turn}`).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('refuses to skip a turn', async () => {
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 2 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'OUT_OF_ORDER' });
    expect(ctx.quests).toHaveLength(1);
  });

  it('is idempotent: a repeat returns the quest already inserted', async () => {
    const first = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    const again = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(ctx.quests).toHaveLength(2);
    expect(again).toMatchObject({ ok: true });
    if (first.ok && again.ok) expect(again.quest.id).toBe(first.quest.id);
  });

  it('holds a retry while the first insert may still be in flight', async () => {
    await ctx.deps.progress.claimTurn('u1', 'demo', sessionId, 0, 1, ctx.deps.now());
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'IN_FLIGHT' });
    expect(ctx.quests).toHaveLength(1);
  });

  it('inserts the quest when the claim was made but the insert never landed', async () => {
    await ctx.deps.progress.claimTurn('u1', 'demo', sessionId, 0, 1, ctx.deps.now());
    ctx.advanceClock(TURN_INSERT_GRACE_MS + 1);
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: true, turn: 1 });
    expect(ctx.quests).toHaveLength(2);
  });

  it('lets only one of two late retries repair a dead insert', async () => {
    await ctx.deps.progress.claimTurn('u1', 'demo', sessionId, 0, 1, ctx.deps.now());
    ctx.advanceClock(TURN_INSERT_GRACE_MS + 1);
    const input = { moduleId: 'demo', sessionId, turn: 1 };
    const results = await Promise.all([advanceModule(ctx.deps, 'u1', input), advanceModule(ctx.deps, 'u1', input)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({ status: 409, code: 'IN_FLIGHT' });
    expect(ctx.quests).toHaveLength(2);
  });

  it('does not claim the next turn while the previous quest is missing', async () => {
    await ctx.deps.progress.claimTurn('u1', 'demo', sessionId, 0, 1, ctx.deps.now());
    ctx.advanceClock(TURN_INSERT_GRACE_MS + 1);
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 2 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'OUT_OF_ORDER' });
    expect(ctx.quests).toHaveLength(1);
    expect(ctx.progress.get('u1')?.demo.turn).toBe(1);
  });

  it('refuses a stale retry for an older turn that never landed', async () => {
    ctx.progress.get('u1')!.demo.turn = 2;
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'OUT_OF_ORDER' });
    expect(ctx.quests).toHaveLength(1);
  });

  it('asks for a restart when the module version moved on', async () => {
    ctx.progress.get('u1')!.demo.moduleVersion = 0;
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 1 });
    expect(r).toMatchObject({ ok: false, status: 409, code: 'VERSION_CHANGED' });
    expect(ctx.quests).toHaveLength(1);
  });
});

describe('advanceModule seeds the recorded canvas', () => {
  const canvas = {
    turn: 2,
    label: 'Mapped the demo',
    addedIds: ['n1'],
    doc: { nodes: [{ id: 'n1', label: 'N1', kind: 'process' as const }], edges: [] },
  };
  let ctx: ReturnType<typeof makeDeps>;
  let sessionId: string;
  const advance = (turn: number, userId = 'u1') =>
    advanceModule(ctx.deps, userId, { moduleId: 'demo', sessionId, turn });
  beforeEach(async () => {
    ctx = makeDeps();
    ctx.deps.modules = [{ ...MODULE, canvas }];
    const started = await startModule(ctx.deps, 'u1', 'demo');
    if (!started.ok) throw new Error('start failed');
    sessionId = started.sessionId;
    await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId, turn: 0 });
  });

  it('writes one ready row beside the canvas turn, covering every seeded quest up to it', async () => {
    await advance(1);
    expect(ctx.canvasRows).toHaveLength(0);
    const r = await advance(2);
    expect(r).toMatchObject({ ok: true, turn: 2 });
    expect(ctx.canvasRows).toEqual([
      {
        sessionId,
        questId: ctx.quests[2].id,
        userId: 'u1',
        coversQuestIds: ctx.quests.map(q => q.id),
        label: canvas.label,
        addedIds: canvas.addedIds,
        doc: canvas.doc,
      },
    ]);
  });

  it('writes nothing for a module without a recorded canvas', async () => {
    ctx.deps.modules = [MODULE];
    await advance(1);
    await advance(2);
    expect(ctx.canvasRows).toHaveLength(0);
  });

  it('a retry seeds the canvas when the first write failed after the quest landed', async () => {
    await advance(1);
    const seed = ctx.deps.canvas!.seed;
    ctx.deps.canvas!.seed = async () => {
      throw new Error('mongo down');
    };
    await expect(advance(2)).rejects.toThrow('mongo down');
    expect(ctx.quests).toHaveLength(3);
    ctx.deps.canvas!.seed = seed;
    expect(await advance(2)).toMatchObject({ ok: true, turn: 2 });
    expect(ctx.quests).toHaveLength(3);
    expect(ctx.canvasRows).toHaveLength(1);
  });

  it("writes nothing for another user's attempt on the session", async () => {
    await advance(1);
    ctx.canvasRows.length = 0;
    expect(await advance(1, 'u2')).toMatchObject({ ok: false, status: 403 });
    expect(ctx.canvasRows).toHaveLength(0);
  });
});

describe('advanceModule from a fresh start', () => {
  it('inserts the opening quest when the journey panel jumps past the first message', async () => {
    const ctx = makeDeps();
    const started = await startModule(ctx.deps, 'u1', 'demo');
    if (!started.ok) throw new Error('start failed');
    const r = await advanceModule(ctx.deps, 'u1', { moduleId: 'demo', sessionId: started.sessionId, turn: 0 });
    expect(r).toMatchObject({ ok: true, turn: 0, quest: { prompt: 'open', reply: 'hello' } });
    expect(ctx.progress.get('u1')!.demo.turn).toBe(0);
  });
});

describe('answerTurn', () => {
  const canvas = {
    turn: 1,
    label: 'Mapped the demo',
    addedIds: ['n1'],
    doc: { nodes: [{ id: 'n1', label: 'N1', kind: 'process' as const }], edges: [] },
  };
  let ctx: ReturnType<typeof makeDeps>;
  let sessionId: string;
  // Core saves the reply onto the user's quest; the fake does the same so the next turn sees its marker.
  const prompts = ['open', 'second', 'third', 'fourth'];
  const send = async (questId: string, userId = 'u1', prompt = prompts[Number(questId.slice(1))]) => {
    const reply = await answerTurn(ctx.deps, userId, sessionId, { id: questId, prompt });
    if (reply) {
      ctx.quests.push({
        id: questId,
        sessionId,
        timestamp: new Date(),
        type: 'message',
        prompt,
        reply: reply.replies.join(''),
        replies: reply.replies,
        status: 'done',
        uiSideEffects: reply.uiSideEffects,
        promptMeta: { session: { id: sessionId, userId } },
      });
    }
    return reply;
  };
  beforeEach(async () => {
    ctx = makeDeps();
    const started = await startModule(ctx.deps, 'u1', 'demo');
    if (!started.ok) throw new Error('start failed');
    sessionId = started.sessionId;
  });

  it('answers each recorded prompt with its reply and marker', async () => {
    expect(await send('m0')).toEqual({
      replies: ['hello'],
      uiSideEffects: [{ type: TUTORIAL_MARKER_TYPE, payload: { moduleId: 'demo', turn: 0 } }],
    });
    expect((await send('m1'))?.replies).toEqual(['two']);
    expect(await send('m2')).toEqual({
      replies: ['three'],
      uiSideEffects: [
        { type: 'applyChange', payload: { x: 1 } },
        { type: TUTORIAL_MARKER_TYPE, payload: { moduleId: 'demo', turn: 2 } },
      ],
    });
    expect(ctx.progress.get('u1')!.demo.turn).toBe(2);
  });

  it('matches the prompt whatever its case and spacing', async () => {
    expect((await send('m0', 'u1', '  OPEN\n'))?.replies).toEqual(['hello']);
  });

  it("hands a message of the user's own to the model and ends the walk", async () => {
    expect(await send('m0', 'u1', 'what is this?')).toBeNull();
    expect(ctx.progress.get('u1')!.demo.status).toBe('left');
    expect(await sessionIsScripted(ctx.deps, 'u1', sessionId)).toBe(false);
    expect(await send('m0')).toBeNull();
  });

  it('hands the turn to the model once the script runs out', async () => {
    for (const id of ['m0', 'm1', 'm2']) await send(id);
    expect(await sessionIsScripted(ctx.deps, 'u1', sessionId)).toBe(false);
    expect(await send('m3')).toBeNull();
  });

  it('hands the turn to the model after the user leaves the tutorial', async () => {
    await send('m0');
    ctx.progress.get('u1')!.demo.status = 'left';
    expect(await sessionIsScripted(ctx.deps, 'u1', sessionId)).toBe(false);
    expect(await send('m1')).toBeNull();
  });

  it('answers nothing in a session no tutorial holds, or for another user', async () => {
    expect(await answerTurn(ctx.deps, 'u1', 'bbbbbbbbbbbbbbbbbbbbbbbb', { id: 'm0', prompt: 'open' })).toBeNull();
    expect(await send('m0', 'u2')).toBeNull();
  });

  it.each([
    ['updated', { ...MODULE, version: 2 }, TUTORIAL_UPDATED_REPLY],
    ['switched off', { ...MODULE, enabled: false }, TUTORIAL_OFF_REPLY],
  ])('says once that the module was %s under the walk, then ends the walk', async (_label, changed, reply) => {
    ctx.deps.modules = [changed];
    expect(await sessionIsScripted(ctx.deps, 'u1', sessionId)).toBe(false);
    expect(await send('m0')).toEqual({ replies: [reply], uiSideEffects: [] });
    expect(ctx.progress.get('u1')!.demo.status).toBe('left');
    expect(ctx.progress.get('u1')!.demo.turn).toBe(-1);
    expect(await send('m0')).toBeNull();
  });

  it('fails a second message that races the first for the same turn', async () => {
    const claim = ctx.deps.progress.claimTurn;
    ctx.deps.progress.claimTurn = async () => false;
    await expect(answerTurn(ctx.deps, 'u1', sessionId, { id: 'm0', prompt: 'open' })).rejects.toThrow('already took');
    ctx.deps.progress.claimTurn = claim;
    expect(ctx.progress.get('u1')!.demo.turn).toBe(-1);
  });

  it('seeds the canvas beside its turn, covering the earlier turns and the unmarked message itself', async () => {
    ctx.deps.modules = [{ ...MODULE, canvas }];
    await send('m0');
    expect(ctx.canvasRows).toHaveLength(0);
    await send('m1');
    expect(ctx.canvasRows).toEqual([
      {
        sessionId,
        questId: 'm1',
        userId: 'u1',
        coversQuestIds: ['m0', 'm1'],
        label: canvas.label,
        addedIds: canvas.addedIds,
        doc: canvas.doc,
      },
    ]);
  });
});

describe('recordPosition and readProgress', () => {
  it('records a known step and refuses an unknown one', async () => {
    const { deps, progress } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    expect(
      await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'in_progress' })
    ).toMatchObject({
      ok: true,
    });
    expect(progress.get('u1')!.demo.stepId).toBe('finish');
    expect(await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'bogus', status: 'left' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('answers 404 when the user has not started the module', async () => {
    const { deps } = makeDeps();
    expect(await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'left' })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('refuses a running walk once its module was switched off, with its own code', async () => {
    const { deps } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    deps.modules = [{ ...MODULE, enabled: false }];
    expect(
      await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'in_progress' })
    ).toMatchObject({
      ok: false,
      status: 410,
      code: 'MODULE_OFF',
    });
  });

  it('refuses a running walk whose version or revision is not the module current one', async () => {
    const { deps } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    const at = (version: number, revision: number) =>
      recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'in_progress', version, revision });
    expect(await at(1, 0)).toMatchObject({ ok: true });
    expect(await at(2, 0)).toMatchObject({ ok: false, status: 409, code: 'VERSION_CHANGED' });
    expect(await at(1, 3)).toMatchObject({ ok: false, status: 409, code: 'VERSION_CHANGED' });
  });

  it('records leaving or finishing a module that changed or was switched off', async () => {
    const { deps, progress } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    deps.modules = [{ ...MODULE, enabled: false, version: 2 }];
    for (const status of ['left', 'finished'] as const) {
      expect(
        await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status, version: 1, revision: 0 })
      ).toMatchObject({ ok: true });
      expect(progress.get('u1')!.demo.status).toBe(status);
    }
  });

  it('reads only the caller own progress', async () => {
    const { deps } = makeDeps();
    await startModule(deps, 'u1', 'demo');
    expect(Object.keys((await readProgress(deps, 'u1')).modules)).toEqual(['demo']);
    expect((await readProgress(deps, 'u2')).modules).toEqual({});
  });
});

describe('enabledModules', () => {
  it('lists enabled modules only, with client fields only', () => {
    const door = {
      id: 'demo',
      title: 'Demo',
      pitch: 'p',
      version: 1,
      revision: 2,
      enabled: true,
      steps: MODULE.steps,
      canvasSolve: { nodeId: 'n1', turn: 1 },
    };
    const listed = enabledModules([
      { ...door, updatedBy: 'admin', reason: 'secret' } as typeof door,
      { ...door, id: 'off', enabled: false },
    ]);
    expect(listed).toEqual([door]);
  });
});

describe('the session marker', () => {
  function withMarker() {
    const made = makeDeps();
    const marks: [string, string | null][] = [];
    made.deps.setSessionMarker = async (sessionId, _userId, moduleId) => {
      marks.push([sessionId, moduleId]);
    };
    return { ...made, marks };
  }

  it('is written on start and again on a restart', async () => {
    const { deps, marks, sessions } = withMarker();
    await startModule(deps, 'u1', 'demo');
    await startModule(deps, 'u1', 'demo');
    expect(marks).toEqual([
      [sessions[0].id, 'demo'],
      [sessions[1].id, 'demo'],
    ]);
  });

  it('is cleared when the walk finishes or is abandoned, not while it runs', async () => {
    const { deps, marks, sessions } = withMarker();
    await startModule(deps, 'u1', 'demo');
    marks.length = 0;
    await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'in_progress' });
    expect(marks).toEqual([]);
    await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'finished' });
    expect(marks).toEqual([[sessions[0].id, null]]);
    await startModule(deps, 'u1', 'demo');
    await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'attach-sheet', status: 'left' });
    expect(marks.at(-1)).toEqual([sessions[1].id, null]);
  });

  it('fails the start when the mark cannot be written, and only warns when it cannot be cleared', async () => {
    const { deps, warnings } = makeDeps();
    deps.setSessionMarker = async () => {
      throw new Error('db down');
    };
    await expect(startModule(deps, 'u1', 'demo')).rejects.toThrow('db down');
    deps.setSessionMarker = async (_s, _u, moduleId) => {
      if (moduleId) return;
      throw new Error('db down');
    };
    await startModule(deps, 'u1', 'demo');
    const r = await recordPosition(deps, 'u1', { moduleId: 'demo', stepId: 'finish', status: 'finished' });
    expect(r.ok).toBe(true);
    expect(warnings.some(w => w.includes('could not unmark'))).toBe(true);
  });
});
