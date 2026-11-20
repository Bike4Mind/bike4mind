// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyOverrides,
  editableOf,
  lockedReason,
  OverrideUnitSchema,
  structuralDigestOf,
  unitState,
  type OverrideUnit,
} from '../overrides';
import { FIXTURE_CONTENT, FIXTURE_POLICY } from './fixture';

const { steps, transcript } = FIXTURE_CONTENT;
const open = steps.find(s => s.id === 'open')!;

type CopyUnit = Extract<OverrideUnit, { kind: 'copy' }>;
const copy = (value: string, repoValue: string | undefined = open.body): CopyUnit => ({
  kind: 'copy',
  stepId: 'open',
  field: 'body',
  value,
  repoValue,
});

describe('unitState', () => {
  it('is live over the repo value it was written against', () => {
    expect(unitState(copy('Fixed.'), steps, transcript)).toBe('live');
  });

  it('is retired once the repo says the same', () => {
    expect(unitState(copy(open.body, 'old text'), steps, transcript)).toBe('retired');
  });

  it('is stale when the repo moved to something else', () => {
    expect(unitState(copy('Fixed.', 'old text'), steps, transcript)).toBe('stale');
  });

  it('is stale when the step is gone', () => {
    expect(unitState({ ...copy('x'), stepId: 'gone' }, steps, transcript)).toBe('stale');
  });

  it('judges a reply against the transcript', () => {
    const reply: OverrideUnit = { kind: 'reply', turn: 0, value: 'Better.', repoValue: transcript[0].reply };
    expect(unitState(reply, steps, transcript)).toBe('live');
    expect(unitState({ ...reply, turn: 9 }, steps, transcript)).toBe('stale');
  });

  it('is stale for an order that is not a permutation of the steps', () => {
    const order: OverrideUnit = { kind: 'order', value: ['open', 'done'], repoValue: steps.map(s => s.id) };
    expect(unitState(order, steps, transcript)).toBe('stale');
  });
});

describe('applyOverrides', () => {
  it('applies live units and leaves its inputs alone', () => {
    const before = JSON.stringify([steps, transcript]);
    const applied = applyOverrides(
      [copy('Fixed.'), { kind: 'reply', turn: 1, value: 'New reply.', repoValue: transcript[1].reply }],
      steps,
      transcript
    );
    expect(applied.steps.find(s => s.id === 'open')!.body).toBe('Fixed.');
    expect(applied.transcript[1].reply).toBe('New reply.');
    expect(JSON.stringify([steps, transcript])).toBe(before);
  });

  it('does not apply a stale unit', () => {
    const applied = applyOverrides([copy('Fixed.', 'old text')], steps, transcript);
    expect(applied.steps.find(s => s.id === 'open')!.body).toBe(open.body);
    expect(applied.states).toEqual([{ key: expect.any(String), state: 'stale' }]);
  });

  it('a prompt edit moves the transcript and the step that sends it', () => {
    const applied = applyOverrides(
      [
        {
          kind: 'prompt',
          turn: 1,
          value: { prompt: 'What is this thing?', reply: transcript[1].reply },
          repoValue: { prompt: transcript[1].prompt, reply: transcript[1].reply },
        },
      ],
      steps,
      transcript
    );
    expect(applied.transcript[1].prompt).toBe('What is this thing?');
    expect(applied.steps.find(s => s.turn === 1)!.prompt).toBe('What is this thing?');
  });

  it('reorders steps when the order unit is live', () => {
    const ids = steps.map(s => s.id);
    const value = [ids[2], ids[0], ids[1]];
    const applied = applyOverrides([{ kind: 'order', value, repoValue: ids }], steps, transcript);
    expect(applied.steps.map(s => s.id)).toEqual(value);
  });
});

describe('structuralDigestOf', () => {
  it('ignores copy edits and moves with structure', () => {
    const ids = steps.map(s => s.id);
    const order: OverrideUnit = { kind: 'order', value: [ids[1], ids[0], ids[2]], repoValue: ids };
    expect(structuralDigestOf([copy('a')])).toBe(structuralDigestOf([copy('b')]));
    expect(structuralDigestOf([order])).not.toBe(structuralDigestOf([]));
  });
});

describe('lockedReason and editableOf', () => {
  it('allows a copy field the policy lists', () => {
    expect(lockedReason('fixture', copy('x'), steps, FIXTURE_POLICY)).toBeNull();
  });

  it('refuses a field derived in code and a pinned one', () => {
    expect(lockedReason('fixture', { ...copy('x'), field: 'doneBody' }, steps, FIXTURE_POLICY)).toMatch(/derived/);
    expect(lockedReason('fixture', { ...copy('x'), stepId: 'done', field: 'title' }, steps, FIXTURE_POLICY)).toMatch(
      /pinned/
    );
  });

  it('refuses everything for a module the policy does not know', () => {
    expect(lockedReason('other', copy('x'), steps, FIXTURE_POLICY)).toMatch(/derived/);
  });

  it('refuses a prompt edit when the sending step does not write its prompt as a literal', () => {
    const prompt: OverrideUnit = {
      kind: 'prompt',
      turn: 0,
      value: { prompt: 'x', reply: 'y' },
      repoValue: { prompt: 'a', reply: 'b' },
    };
    expect(lockedReason('fixture', prompt, steps, FIXTURE_POLICY)).toMatch(/derived/);
  });

  it('drops pinned fields from what an editor may change', () => {
    expect(editableOf('fixture', FIXTURE_POLICY).done).toEqual(['body']);
    expect(editableOf('other', FIXTURE_POLICY)).toEqual({});
  });
});

describe('OverrideUnitSchema', () => {
  it('rejects a copy unit for a field outside the copy set', () => {
    expect(OverrideUnitSchema.safeParse({ ...copy('x'), field: 'id' }).success).toBe(false);
  });
});
