import { describe, expect, it } from 'vitest';
import { parseOrchestrateMiniPayload, type OrchestrateMiniPayload } from './orchestrateMini';
import { VIEW_SNAPSHOT_CONTRACT } from './viewSnapshot';

const valid: OrchestrateMiniPayload = {
  snapshot: {
    contract: VIEW_SNAPSHOT_CONTRACT,
    root: { id: 'root', state: 'needs-you' },
    agents: [{ id: 'a', title: 'Agent 1', state: 'working', parentId: 'root', depth: 1, updatedAt: '2026-11-01' }],
  },
  presenting: true,
  skin: {
    id: 'nightglass',
    states: { working: '#3366ff' },
    surfaces: { stage: '#101820' },
    fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
  },
};

describe('parseOrchestrateMiniPayload', () => {
  it('accepts a well-formed payload and passes it through unchanged', () => {
    expect(parseOrchestrateMiniPayload(valid)).toEqual(valid);
  });

  it('reads null as "no orchestration on stage"', () => {
    expect(parseOrchestrateMiniPayload(null)).toBeNull();
  });

  it.each([
    ['no payload at all', undefined],
    ['a string', 'payload'],
    ['an unknown top-level key', { ...valid, prompt: 'leaked' }],
    ['an unknown snapshot contract', { ...valid, snapshot: { ...valid.snapshot, contract: 2 } }],
    [
      'an agent field outside the contract',
      { ...valid, snapshot: { ...valid.snapshot, agents: [{ ...valid.snapshot.agents[0], seedPrompt: 'x' }] } },
    ],
    ['an unknown agent state', { ...valid, snapshot: { ...valid.snapshot, root: { id: 'root', state: 'asleep' } } }],
    ['a needs-you skin colour', { ...valid, skin: { ...valid.skin, states: { 'needs-you': '#ff0000' } } }],
    ['a colour that is not #rrggbb', { ...valid, skin: { ...valid.skin, surfaces: { stage: 'red; x: url(a)' } } }],
    ['a font stack with CSS in it', { ...valid, skin: { ...valid.skin, fontFamily: 'serif; background: url(x)' } }],
    ['a missing presenting flag', { snapshot: valid.snapshot, skin: valid.skin }],
  ])('drops %s', (_label, value) => {
    expect(parseOrchestrateMiniPayload(value)).toBeUndefined();
  });
});
