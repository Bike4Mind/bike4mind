import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalLoopStore } from './LocalLoopStore';
import { MAX_DIRECTIVES_PER_RUN, openDirectivesFor } from './overseerTools';
import { testLoop } from './testLoop';
import { runTicketTool, type ToolRun } from './ticketTools';

const setup = (oversees = ['worker']) => {
  const store = new LocalLoopStore(join(mkdtempSync(join(tmpdir(), 'b4m-overseer-')), 'l.sqlite'), () => 'a');
  store.putLoop(testLoop({ id: 'boss', name: 'Boss', oversees }));
  store.putLoop(testLoop({ id: 'worker', name: 'Worker', memory: { notes: 'did a thing', nextAction: 'next' } }));
  store.putLoop(testLoop({ id: 'stranger', name: 'Stranger' }));
  const as = (loopId: string, runId = 'run-1'): ToolRun => ({ loopId, runId, creates: 0 });
  const call = (run: ToolRun, tool: string, input: Record<string, unknown>) =>
    runTicketTool(
      store,
      run,
      tool,
      input,
      () => undefined,
      loop => ({
        loop,
        lanesBusy: 0,
        spentToday: 3,
        needsYou: 0,
        idleReason: 'no work',
      })
    );
  const json = (run: ToolRun, tool: string, input: Record<string, unknown>) => JSON.parse(call(run, tool, input));
  return { store, as, call, json };
};

describe('local overseer tools', () => {
  it('reads the state of the loops it oversees, and only those', () => {
    const { as, json, call } = setup();
    const { loops } = json(as('boss'), 'loop_oversee_status', {});
    expect(loops).toEqual([
      expect.objectContaining({
        id: 'worker',
        name: 'Worker',
        status: 'live',
        idleReason: 'no work',
        spentToday: 3,
        memory: { notes: 'did a thing', nextAction: 'next' },
      }),
    ]);
    expect(call(as('boss'), 'loop_oversee_status', { loopId: 'stranger' })).toBe('Error: Loop not found.');
  });

  it('refuses every overseer call from a loop that oversees nothing', () => {
    const { as, call } = setup([]);
    expect(call(as('boss'), 'loop_directive_issue', { loopId: 'worker', instruction: 'x', reason: 'y' })).toBe(
      'Error: This loop oversees no loops.'
    );
  });

  it('issues a directive the worker accepts, pushes back on, and its next run sees', () => {
    const { store, as, json, call } = setup();
    const sent = json(as('boss'), 'loop_directive_issue', {
      loopId: 'worker',
      instruction: 'Fix the flaky test first',
      reason: 'It blocks every PR',
    });
    expect(sent).toMatchObject({ loopId: 'worker', state: 'open' });
    expect(openDirectivesFor(store, 'worker', 10).map(directive => directive.id)).toEqual([sent.id]);

    // Only the worker answers, and a push-back needs a reason.
    expect(call(as('boss'), 'loop_directive_respond', { directiveId: sent.id, outcome: 'accepted' })).toBe(
      'Error: Directive not found.'
    );
    expect(call(as('worker'), 'loop_directive_respond', { directiveId: sent.id, outcome: 'pushed_back' })).toBe(
      'Error: note is required to push back'
    );
    json(as('worker'), 'loop_directive_respond', { directiveId: sent.id, outcome: 'accepted' });
    expect(
      json(as('worker'), 'loop_directive_respond', { directiveId: sent.id, outcome: 'pushed_back', note: 'Not flaky' })
    ).toMatchObject({ state: 'pushed_back' });
    expect(store.directive(sent.id)?.replies.map(reply => reply.outcome)).toEqual(['accepted', 'pushed_back']);
    expect(openDirectivesFor(store, 'worker', 10)).toEqual([]);
  });

  it('refuses an answer to a withdrawn directive', () => {
    const { store, as, json, call } = setup();
    const sent = json(as('boss'), 'loop_directive_issue', { loopId: 'worker', instruction: 'x', reason: 'y' });
    store.putDirective({ ...store.directive(sent.id)!, state: 'withdrawn' });
    expect(call(as('worker'), 'loop_directive_respond', { directiveId: sent.id, outcome: 'done' })).toBe(
      'Error: directive is withdrawn'
    );
  });

  it(`caps a run at ${MAX_DIRECTIVES_PER_RUN} directives and actions`, () => {
    const { as, json, call } = setup();
    for (let i = 0; i < MAX_DIRECTIVES_PER_RUN; i++)
      json(as('boss'), 'loop_directive_issue', { loopId: 'worker', instruction: `do ${i}`, reason: 'r' });
    expect(call(as('boss'), 'loop_run_now', { loopId: 'worker', reason: 'r' })).toMatch(/at most 5 directives/);
    expect(json(as('boss', 'run-2'), 'loop_run_now', { loopId: 'worker', reason: 'r' })).toMatchObject({
      loopId: 'worker',
    });
  });

  it('runs a live worker now, and logs it as a done action', () => {
    const { store, as, json } = setup();
    json(as('boss'), 'loop_run_now', { loopId: 'worker', reason: 'Idle with ready work' });
    expect(store.directives('worker')[0]).toMatchObject({ action: 'run_now', state: 'done' });
    expect(openDirectivesFor(store, 'worker', 10)).toEqual([]);
  });

  it('resumes a worker in error once per 24 h, and never a paused one', () => {
    const { store, as, json, call } = setup();
    store.putLoop({ ...store.loop('worker')!, status: 'paused' });
    expect(call(as('boss'), 'loop_resume', { loopId: 'worker', reason: 'r' })).toBe(
      'Error: loop is paused; only an error loop can be resumed'
    );
    store.putLoop({ ...store.loop('worker')!, status: 'error', error: 'boom', errorStreak: 3 });
    expect(json(as('boss'), 'loop_resume', { loopId: 'worker', reason: 'Fixed the key' })).toMatchObject({
      status: 'live',
    });
    expect(store.loop('worker')).toMatchObject({ status: 'live', errorStreak: 0 });
    expect(store.loop('worker')?.error).toBeUndefined();
    store.putLoop({ ...store.loop('worker')!, status: 'error', error: 'boom again' });
    expect(call(as('boss', 'run-2'), 'loop_resume', { loopId: 'worker', reason: 'r' })).toBe(
      'Error: already resumed in the last 24 h; leave it to the owner'
    );
  });

  it('drops a deleted loop from its overseer and deletes the directives both ways', () => {
    const { store, as, json } = setup();
    json(as('boss'), 'loop_directive_issue', { loopId: 'worker', instruction: 'x', reason: 'y' });
    store.deleteLoop('worker');
    expect(store.loop('boss')?.oversees).toEqual([]);
    expect(store.directives('boss')).toEqual([]);
  });
});
