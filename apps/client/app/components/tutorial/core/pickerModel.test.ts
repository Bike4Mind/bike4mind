import { describe, expect, it } from 'vitest';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';
import { groupByTrack, nextInTrack, statusOf } from './pickerModel';

const tutorial = (id: string, track?: TutorialRunModule['track']): TutorialRunModule => ({
  id,
  title: id,
  pitch: '',
  version: 1,
  revision: 0,
  enabled: true,
  steps: [
    { id: `${id}-a`, type: 'point', body: 'a' },
    { id: `${id}-end`, type: 'bridge', body: 'end' },
  ],
  ...(track && { track }),
});

const entry = (patch: Partial<TutorialProgressEntry>): TutorialProgressEntry => ({
  status: 'in_progress',
  sessionId: 's1',
  moduleVersion: 1,
  ...patch,
});

describe('statusOf', () => {
  const m = tutorial('m');

  it('reads a tutorial never begun as not started', () => {
    expect(statusOf(m, undefined)).toBe('not_started');
  });

  it('reads a running or left walk as in progress', () => {
    expect(statusOf(m, entry({ stepId: 'm-a' }))).toBe('in_progress');
    expect(statusOf(m, entry({ status: 'left', stepId: 'm-a' }))).toBe('in_progress');
  });

  it('reads a finished walk, or one left on the closing card, as finished', () => {
    expect(statusOf(m, entry({ status: 'finished', stepId: 'm-end' }))).toBe('finished');
    expect(statusOf(m, entry({ status: 'left', stepId: 'm-end' }))).toBe('finished');
  });

  it('reads a walk saved on an older version as not started, since it cannot be picked up', () => {
    expect(statusOf(m, entry({ moduleVersion: 0, stepId: 'm-a' }))).toBe('not_started');
  });

  it('reads the live tutorial as in progress whatever was saved', () => {
    expect(statusOf(m, undefined, 'm')).toBe('in_progress');
  });
});

describe('groupByTrack', () => {
  it('lists the basics first, then what is different, then the rest, dropping empty groups', () => {
    const groups = groupByTrack([tutorial('x'), tutorial('d', 'different'), tutorial('b', 'basics')]);
    expect(groups.map(g => [g.key, g.modules.map(m => m.id)])).toEqual([
      ['basics', ['b']],
      ['different', ['d']],
      ['other', ['x']],
    ]);
    expect(groupByTrack([tutorial('b', 'basics')]).map(g => g.key)).toEqual(['basics']);
  });
});

describe('nextInTrack', () => {
  const modules = [tutorial('b1', 'basics'), tutorial('b2', 'basics'), tutorial('d1', 'different')];

  it('continues a tutorial in progress before starting another', () => {
    expect(nextInTrack(modules, { b2: entry({ stepId: 'b2-a' }) }, 'basics')).toMatchObject({
      tutorial: { id: 'b2' },
      status: 'in_progress',
    });
  });

  it('starts the first tutorial not finished', () => {
    expect(nextInTrack(modules, { b1: entry({ status: 'finished' }) }, 'basics')?.tutorial.id).toBe('b2');
  });

  it('replays the first tutorial once all are finished, and has nothing for an empty track', () => {
    const done = { b1: entry({ status: 'finished' }), b2: entry({ status: 'finished' }) };
    expect(nextInTrack(modules, done, 'basics')).toMatchObject({ tutorial: { id: 'b1' }, status: 'finished' });
    expect(nextInTrack([tutorial('b1', 'basics')], undefined, 'different')).toBeUndefined();
  });
});
