// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TutorialStep, TutorialTurn } from '@bike4mind/common';
import {
  captureSession,
  scrubPlainTranscript,
  type CaptureDeps,
  type CaptureHooks,
  type CaptureSession,
} from '../capture';
import { createDraftCore, type DraftProfile } from '../draftCore';

const ATTACH_TYPE = 'attach';
const profile: DraftProfile = {
  params: { prompt: z.any(), attach: z.any() },
  sendTypes: ['prompt'],
  attachType: ATTACH_TYPE,
  starterSteps: (transcript: readonly TutorialTurn[]): TutorialStep[] =>
    transcript.flatMap((t, turn): TutorialStep[] => [
      ...(t.attachSheet ? [{ id: `turn-${turn}-attach`, type: ATTACH_TYPE, body: 'Attach it.' }] : []),
      { id: `turn-${turn}`, type: 'prompt', turn, body: 'Send it.' },
    ]),
  defaultFinale: { title: 'Done', body: 'You did it.' },
  isRepoModuleId: id => id === 'taken',
  withFinale: steps => steps,
  validateModule: () => [],
  requireVisibility: true,
};
const core = createDraftCore(profile);

const done = (id: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: 'done',
  prompt,
  replies: [`<think>hmm</think>answer to ${prompt}`],
  createdAt: `2026-01-01T00:00:0${id.slice(1)}Z`,
  ...extra,
});
const QUESTS = [done('q1', 'first'), done('q2', 'second', { fabFileIds: ['f1'] })];

const SESSION: CaptureSession = { name: 'My chat', users: [], groups: [], isGlobalWrite: false, surface: null };

function deps(session: CaptureSession | null = SESSION, quests: unknown[] = QUESTS): CaptureDeps {
  return { loadOwnedSession: async () => session, quests: async () => quests as never };
}

const coreHooks: CaptureHooks<{ turn: number }> = {
  acceptsSurface: surface => !surface,
  foreignToolPrefixes: ['other_'],
  scrub: scrubPlainTranscript,
};

const capture = (d: CaptureDeps, hooks = coreHooks, input: Partial<Parameters<typeof captureSession>[5]> = {}) =>
  captureSession(core, profile, d, hooks, 'u1', {
    sessionId: 's1',
    moduleId: 'mine',
    title: ' My tutorial ',
    visibility: { entitlement: 'k' },
    ...input,
  });

describe('captureSession under the core hooks', () => {
  it('captures a main-surface session with no canvas and an attach starter step', async () => {
    const result = await capture(deps());
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    const { content } = result;
    expect(content.canvas).toBeUndefined();
    expect(content.title).toBe('My tutorial');
    expect(content.visibility).toEqual({ entitlement: 'k' });
    expect(content.transcript.map(t => t.reply)).toEqual(['answer to first', 'answer to second']);
    expect(content.steps.map(s => s.type)).toEqual(['prompt', 'attach', 'prompt']);
    expect(content.steps[1].params).toEqual({ fileName: '' });
    expect(content.steps[2].prompt).toBe('second');
  });

  it.each(['opti', 'anything-else'])('refuses a session on surface %s with 409 SURFACE', async surface => {
    expect(await capture(deps({ ...SESSION, surface }))).toMatchObject({ ok: false, status: 409, code: 'SURFACE' });
  });

  it('refuses a session moved to main whose quests called another surface tool', async () => {
    const quests = [
      done('q1', 'first', { structuredReplies: [{ content: [{ type: 'tool_use', name: 'other_schedule' }] }] }),
      done('q2', 'second'),
    ];
    expect(await capture(deps(SESSION, quests))).toMatchObject({ ok: false, status: 409, code: 'SURFACE' });
  });

  it('accepts a session whose tools carry no foreign prefix', async () => {
    const quests = [
      done('q1', 'first', { structuredReplies: [{ content: [{ type: 'tool_use', name: 'web_search' }, 'text'] }] }),
      done('q2', 'second'),
    ];
    expect(await capture(deps(SESSION, quests))).toMatchObject({ ok: true });
  });

  it('refuses a session carrying a tutorial marker with 409 TUTORIAL_SESSION', async () => {
    const marked = { ...SESSION, tutorial: { owner: 'core', moduleId: 'x' } };
    expect(await capture(deps(marked))).toMatchObject({ status: 409, code: 'TUTORIAL_SESSION' });
  });
});

describe('captureSession refusals', () => {
  it('refuses a bad id with 400 and a taken id with 409 ID_TAKEN', async () => {
    expect(await capture(deps(), coreHooks, { moduleId: 'Bad Id' })).toMatchObject({ status: 400 });
    expect(await capture(deps(), coreHooks, { moduleId: 'taken' })).toMatchObject({ status: 409, code: 'ID_TAKEN' });
  });

  it("refuses a session that is not the caller's with 404", async () => {
    expect(await capture(deps(null))).toMatchObject({ status: 404 });
  });

  it.each([{ users: ['u2'] }, { groups: ['g'] }, { isGlobalWrite: true }])(
    'refuses a shared session %o with 409 SESSION_SHARED',
    async shared => {
      expect(await capture(deps({ ...SESSION, ...shared }))).toMatchObject({ status: 409, code: 'SESSION_SHARED' });
    }
  );

  it('refuses a tutorial-named session and a marked quest with 409 TUTORIAL_SESSION', async () => {
    expect(await capture(deps({ ...SESSION, name: 'Tutorial: Something' }))).toMatchObject({
      status: 409,
      code: 'TUTORIAL_SESSION',
    });
    const marked = [done('q1', 'a', { uiSideEffects: [{ type: 'tutorialMarker', payload: {} }] }), done('q2', 'b')];
    expect(await capture(deps(SESSION, marked))).toMatchObject({ status: 409, code: 'TUTORIAL_SESSION' });
  });

  it('refuses fewer than two turns with 422 TOO_SHORT', async () => {
    expect(await capture(deps(SESSION, [QUESTS[0]]))).toMatchObject({ status: 422, code: 'TOO_SHORT' });
  });

  it('refuses an unfinished turn with 422 UNFINISHED', async () => {
    const quests = [QUESTS[0], { ...QUESTS[1], status: 'running' }];
    expect(await capture(deps(SESSION, quests))).toMatchObject({ status: 422, code: 'UNFINISHED' });
  });
});

describe('captureSession with an owner canvas hook', () => {
  const canvas = { turn: 1 };
  const hooks = (result: Awaited<ReturnType<NonNullable<CaptureHooks<{ turn: number }>['canvas']>>>) => ({
    ...coreHooks,
    canvas: async () => result,
  });

  it('adds the canvas and node the hook returns', async () => {
    const result = await capture(deps(), hooks({ ok: true, canvas, canvasNodeId: 'n1' }));
    expect(result).toMatchObject({ ok: true, content: { canvas, canvasNodeId: 'n1' } });
  });

  it('passes the hook refusal through', async () => {
    const refusal = { ok: false as const, status: 422, error: 'no canvas', code: 'NO_CANVAS' };
    expect(await capture(deps(), hooks(refusal))).toEqual(refusal);
  });

  it('hands the hook the scrubbed transcript', async () => {
    let seen: TutorialTurn[] = [];
    await capture(deps(), {
      ...coreHooks,
      canvas: async input => {
        seen = input.transcript;
        return { ok: true, canvas };
      },
    });
    expect(seen.map(t => t.reply)).toEqual(['answer to first', 'answer to second']);
  });

  it('lets an owner accept its own surface and refuse main', async () => {
    const owner = { ...coreHooks, acceptsSurface: (s: string | undefined) => s === 'opti' };
    expect(await capture(deps({ ...SESSION, surface: 'opti' }), owner)).toMatchObject({ ok: true });
    expect(await capture(deps(), owner)).toMatchObject({ status: 409, code: 'SURFACE' });
  });
});

describe('scrubPlainTranscript', () => {
  it('strips reasoning, tool results and UI side effects', () => {
    const turns: TutorialTurn[] = [
      {
        prompt: '<think>x</think> hi ',
        reply: '<think>y</think> there ',
        uiSideEffects: [{ type: 'populateProblem', payload: {} }],
        toolResults: [{ tool_use_id: 't', content: 'c' }],
        attachSheet: true,
      },
    ];
    expect(scrubPlainTranscript(turns)).toEqual([{ prompt: 'hi', reply: 'there', attachSheet: true }]);
  });
});
