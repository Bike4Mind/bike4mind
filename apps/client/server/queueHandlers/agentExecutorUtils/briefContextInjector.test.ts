import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@bike4mind/services';
import { injectBriefContext, appendBriefToObservation, extractLoadedProblem } from './briefContextInjector';

const familyEnvelope = (problem: unknown, displayMessage = 'summary') =>
  JSON.stringify({
    __uiSideEffect: true,
    type: 'populateFamilyProblem',
    payload: { familyId: 'routing', problem },
    displayMessage,
  });
const schedulingEnvelope = (problem: unknown) =>
  JSON.stringify({ __uiSideEffect: true, type: 'populateProblem', payload: problem, displayMessage: 'sched' });
const decompEnvelope = (instances: unknown[]) =>
  JSON.stringify({
    __uiSideEffect: true,
    type: 'populateDecomposition',
    payload: { decomposition: { steps: [] }, instances },
    displayMessage: 'loaded step 1',
  });

function fakeTool(name: string, result: string): { tool: ToolDefinition; calls: unknown[] } {
  const calls: unknown[] = [];
  const tool = {
    name,
    implementation: () => ({
      toolFn: async (p?: unknown) => {
        calls.push(p);
        return result;
      },
      toolSchema: { name, description: '', parameters: { type: 'object', properties: {} } },
    }),
  } as unknown as ToolDefinition;
  return { tool, calls };
}
const run = (t: ToolDefinition, p?: unknown) => t.implementation({} as never, undefined).toolFn(p);

describe('extractLoadedProblem', () => {
  it('reads the problem from each populate* payload shape', () => {
    expect(extractLoadedProblem('populateProblem', { name: 'S' })).toEqual({ name: 'S' });
    expect(
      extractLoadedProblem('populateFamilyProblem', { familyId: 'routing', problem: { family: 'routing' } })
    ).toEqual({ family: 'routing' });
    expect(
      extractLoadedProblem('populateDecomposition', { instances: [{ problem: { family: 'scheduling' } }] })
    ).toEqual({ family: 'scheduling' });
  });
  it('returns null for plan-only decomposition (instances[0] === null) and unknown types', () => {
    expect(extractLoadedProblem('populateDecomposition', { instances: [null] })).toBeNull();
    expect(extractLoadedProblem('somethingElse', { problem: {} })).toBeNull();
  });
});

describe('appendBriefToObservation', () => {
  it('appends the exact family problem JSON + a solve hint naming the family', () => {
    const out = appendBriefToObservation(familyEnvelope({ family: 'routing', name: 'Route' }));
    const env = JSON.parse(out);
    expect(env.type).toBe('populateFamilyProblem'); // envelope + payload preserved
    expect(env.payload.problem).toEqual({ family: 'routing', name: 'Route' });
    expect(env.displayMessage).toContain('ACTIVE BRIEF');
    expect(env.displayMessage).toContain('"family":"routing"');
    expect(env.displayMessage).toMatch(/optihashi_solve.*"family" is already "routing"/s);
    expect(env.displayMessage).toContain('summary'); // original summary retained
  });

  it('uses the scheduling hint for a populateProblem (no family field)', () => {
    const out = appendBriefToObservation(schedulingEnvelope({ name: 'Shop', jobs: [] }));
    expect(JSON.parse(out).displayMessage).toMatch(/optihashi_schedule/);
  });

  it('appends step-1 brief from a decomposition', () => {
    const out = appendBriefToObservation(decompEnvelope([{ problem: { family: 'scheduling', name: 'Seq' } }]));
    expect(JSON.parse(out).displayMessage).toContain('"name":"Seq"');
  });

  it('leaves plan-only decompositions, non-envelopes, and problemless envelopes untouched', () => {
    const planOnly = decompEnvelope([null]);
    expect(appendBriefToObservation(planOnly)).toBe(planOnly);
    expect(appendBriefToObservation('Error: could not formulate')).toBe('Error: could not formulate');
    const noProblem = JSON.stringify({
      __uiSideEffect: true,
      type: 'populateProblem',
      payload: null,
      displayMessage: 'x',
    });
    expect(appendBriefToObservation(noProblem)).toBe(noProblem);
  });
});

describe('injectBriefContext', () => {
  it('augments brief-setting tool observations and passes other tools through', async () => {
    const formulate = fakeTool('optihashi_formulate', familyEnvelope({ family: 'selection', name: 'Pick' }));
    const solve = fakeTool('optihashi_solve', '## Results ...');
    const g = injectBriefContext({
      optihashi_formulate: formulate.tool,
      optihashi_solve: solve.tool,
      optihashi_decompose: fakeTool('optihashi_decompose', '{}').tool,
    });

    const formOut = await run(g.optihashi_formulate);
    expect(JSON.parse(formOut).displayMessage).toContain('ACTIVE BRIEF');
    // solve is not a brief-setter -> untouched
    expect(await run(g.optihashi_solve)).toBe('## Results ...');
  });

  it('returns the map unchanged for a non-opti run (no formulate/decompose)', () => {
    const map = { web_search: fakeTool('web_search', 'ok').tool };
    expect(injectBriefContext(map)).toBe(map);
  });
});
